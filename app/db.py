import os as _os
from collections.abc import Generator
from contextlib import contextmanager
from datetime import date
from pathlib import Path
from typing import Optional

from sqlalchemy import Boolean, Date, Float, ForeignKey, Integer, String, create_engine, select, text
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

DB_PATH = Path(_os.environ.get("RENTAL_DB_PATH") or Path(__file__).resolve().parent.parent / "rental.db")
engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


class Base(DeclarativeBase):
    pass


class AuthorizedUser(Base):
    __tablename__ = "authorized_users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True)


SEED_EMAILS = ("nguyenmaihuong282@gmail.com",)


def admin_email() -> str:
    """Admin email from the ADMIN_EMAIL env var. Always lowercased for comparisons."""
    return _os.environ.get("ADMIN_EMAIL", "").strip().lower()


def seed_authorized_users() -> None:
    """Ensure the admin and all SEED_EMAILS exist in the allowlist."""
    with Session(engine) as s:
        existing = {u.email for u in s.scalars(select(AuthorizedUser)).all()}
        for email in (admin_email(), *SEED_EMAILS):
            if email and email not in existing:
                s.add(AuthorizedUser(email=email))
        s.commit()


class BillingKind(Base):
    __tablename__ = "billing_kinds"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True)


DEFAULT_BILLING_KINDS = ["water", "electric", "gas", "combined"]


def seed_billing_kinds() -> None:
    with Session(engine) as s:
        existing = {k.name for k in s.scalars(select(BillingKind)).all()}
        for name in DEFAULT_BILLING_KINDS:
            if name not in existing:
                s.add(BillingKind(name=name))
        s.commit()


class Unit(Base):
    __tablename__ = "units"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True)
    note: Mapped[str] = mapped_column(String, default="")

    occupancies: Mapped[list["Occupancy"]] = relationship(
        back_populates="unit", cascade="all, delete-orphan"
    )


class Occupancy(Base):
    __tablename__ = "occupancies"
    id: Mapped[int] = mapped_column(primary_key=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("units.id", ondelete="CASCADE"))
    tenant_count: Mapped[int] = mapped_column(Integer)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)

    unit: Mapped[Unit] = relationship(back_populates="occupancies")


class RecurringBill(Base):
    __tablename__ = "recurring_bills"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String)
    amount: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(String, default="")
    # "daily" | "weekly" | "monthly" | "yearly"
    recurrence: Mapped[str] = mapped_column(String)
    # JSON list of ints:
    #   weekly  → weekday indices [0=Mon..6=Sun]
    #   monthly → day-of-month [1-31]
    #   yearly  → month numbers [1-12]
    recurrence_config: Mapped[str] = mapped_column(String, default="[]")
    start_date: Mapped[date] = mapped_column(Date)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

    assignments: Mapped[list["RecurringBillUnit"]] = relationship(
        back_populates="recurring_bill", cascade="all, delete-orphan"
    )


class RecurringBillUnit(Base):
    __tablename__ = "recurring_bill_units"
    id: Mapped[int] = mapped_column(primary_key=True)
    recurring_bill_id: Mapped[int] = mapped_column(
        ForeignKey("recurring_bills.id", ondelete="CASCADE")
    )
    unit_id: Mapped[int] = mapped_column(ForeignKey("units.id", ondelete="CASCADE"))

    recurring_bill: Mapped[RecurringBill] = relationship(back_populates="assignments")
    unit: Mapped[Unit] = relationship()


class Bill(Base):
    __tablename__ = "bills"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String)  # water, electric, gas, combined
    amount: Mapped[float] = mapped_column(Float)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    note: Mapped[str] = mapped_column(String, default="")
    recurring_bill_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("recurring_bills.id", ondelete="SET NULL"), nullable=True, default=None
    )

    assignments: Mapped[list["BillUnit"]] = relationship(
        back_populates="bill", cascade="all, delete-orphan"
    )


class BillUnit(Base):
    __tablename__ = "bill_units"
    id: Mapped[int] = mapped_column(primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("bills.id", ondelete="CASCADE"))
    unit_id: Mapped[int] = mapped_column(ForeignKey("units.id", ondelete="CASCADE"))

    bill: Mapped[Bill] = relationship(back_populates="assignments")
    unit: Mapped[Unit] = relationship()


class Payment(Base):
    """A payment a unit made toward a specific (year, month, kind) cell on the dashboard."""
    __tablename__ = "payments"
    id: Mapped[int] = mapped_column(primary_key=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("units.id", ondelete="CASCADE"))
    year: Mapped[int] = mapped_column(Integer)
    month: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String)
    amount: Mapped[float] = mapped_column(Float)

    unit: Mapped[Unit] = relationship()


def init_db() -> None:
    Base.metadata.create_all(engine)
    # Additive migration: add recurring_bill_id to bills if it doesn't exist yet.
    with engine.connect() as conn:
        try:
            conn.execute(text(
                "ALTER TABLE bills ADD COLUMN recurring_bill_id INTEGER "
                "REFERENCES recurring_bills(id) ON DELETE SET NULL"
            ))
            conn.commit()
        except Exception:
            pass  # Column already exists


@contextmanager
def get_session() -> Generator[Session, None, None]:
    with Session(engine) as s:
        yield s
        s.commit()
