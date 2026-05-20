import os as _os
from collections.abc import Generator
from contextlib import contextmanager
from datetime import date
from pathlib import Path

from sqlalchemy import Date, Float, ForeignKey, Integer, String, create_engine, select
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


class Bill(Base):
    __tablename__ = "bills"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String)  # water, electric, gas, combined
    amount: Mapped[float] = mapped_column(Float)
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    note: Mapped[str] = mapped_column(String, default="")

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


def init_db() -> None:
    Base.metadata.create_all(engine)


@contextmanager
def get_session() -> Generator[Session, None, None]:
    with Session(engine) as s:
        yield s
        s.commit()
