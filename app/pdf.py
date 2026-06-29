from collections import defaultdict
from dataclasses import dataclass
from datetime import date
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.billing import _overlap_days, bill_due_date, split_bill
from app.db import Bill, Occupancy

MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


@dataclass
class _CellAgg:
    owed: float = 0.0
    paid: float = 0.0


def _attribute_to_occupancy(
    bill: Bill, target_unit_id: int, target_occ: Occupancy,
    occ_map: dict[int, list[Occupancy]],
) -> tuple[float, float]:
    """Return (occ_share, unit_share) of a bill's amount for the target occupancy.

    occ_map MUST contain occupancies for every unit assigned to the bill — otherwise
    split_bill will treat missing units as 0 person-days and overweight the rest.

    Within a unit, splits the unit's share proportionally across its occupancies by
    person-days overlapping the bill's period. For the common single-occupancy unit,
    occ_share == unit_share.
    """
    shares = split_bill(bill, occ_map)
    unit_share = next((sh.amount for sh in shares if sh.unit_id == target_unit_id), 0.0)
    if unit_share == 0:
        return 0.0, 0.0
    all_occs_for_unit = occ_map.get(target_unit_id, [])
    target_pd = (
        _overlap_days(target_occ.start_date, target_occ.end_date, bill.start_date, bill.end_date)
        * target_occ.tenant_count
    )
    total_pd = sum(
        _overlap_days(o.start_date, o.end_date, bill.start_date, bill.end_date) * o.tenant_count
        for o in all_occs_for_unit
    )
    if total_pd == 0:
        return 0.0, unit_share
    return unit_share * (target_pd / total_pd), unit_share


def build_statement_pdf(sections: list[dict]) -> bytes:
    """Render a multi-section statement PDF.

    sections: list of dicts with keys:
      - title: str (e.g. "Unit A1 — 2 tenants, 2026-01-01 to 2026-06-30")
      - months: list of dicts {year, month, rows: [(category, owed, paid)], subtotal_owed, subtotal_paid, subtotal_remaining}
      - total_owed, total_paid, total_outstanding
    """
    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.6 * inch, rightMargin=0.6 * inch,
        topMargin=0.6 * inch, bottomMargin=0.6 * inch,
        title="Rental statement",
    )
    styles = getSampleStyleSheet()
    h1 = styles["Heading1"]
    h2 = styles["Heading2"]
    h3 = styles["Heading3"]
    body = styles["BodyText"]
    muted = ParagraphStyle("muted", parent=body, textColor=colors.grey, fontSize=9)

    story = []
    story.append(Paragraph("Rental statement", h1))
    story.append(Paragraph(f"Generated {date.today().isoformat()}", muted))
    story.append(Spacer(1, 0.2 * inch))

    for i, sec in enumerate(sections):
        if i > 0:
            story.append(PageBreak())
        story.append(Paragraph(sec["title"], h2))
        if sec.get("subtitle"):
            story.append(Paragraph(sec["subtitle"], muted))
        story.append(Spacer(1, 0.1 * inch))

        if not sec["months"]:
            story.append(Paragraph("No bills in scope.", body))
        else:
            for m in sec["months"]:
                month_label = f"{MONTH_NAMES[m['month'] - 1]} {m['year']}"
                story.append(Paragraph(month_label, h3))
                data = [["Category", "Owed", "Paid", "Remaining"]]
                for cat, owed, paid in m["rows"]:
                    data.append([
                        cat,
                        f"${owed:,.2f}",
                        f"${paid:,.2f}",
                        f"${(owed - paid):,.2f}",
                    ])
                data.append([
                    "Total",
                    f"${m['subtotal_owed']:,.2f}",
                    f"${m['subtotal_paid']:,.2f}",
                    f"${m['subtotal_remaining']:,.2f}",
                ])
                tbl = Table(data, colWidths=[2.5 * inch, 1.3 * inch, 1.3 * inch, 1.3 * inch])
                tbl.setStyle(TableStyle([
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f4f4f4")),
                    ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                    ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ]))
                story.append(tbl)
                story.append(Spacer(1, 0.15 * inch))

        # Summary
        story.append(Spacer(1, 0.1 * inch))
        summary = Table([
            ["Total owed", f"${sec['total_owed']:,.2f}"],
            ["Total paid", f"${sec['total_paid']:,.2f}"],
            ["Outstanding balance", f"${sec['total_outstanding']:,.2f}"],
        ], colWidths=[3 * inch, 1.5 * inch])
        summary.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
            ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("LINEABOVE", (0, -1), (-1, -1), 1, colors.grey),
            ("TOPPADDING", (0, -1), (-1, -1), 6),
        ]))
        story.append(summary)

    doc.build(story)
    return buf.getvalue()


def build_section_for_occupancy(
    unit, occupancy: Occupancy,
    bills_for_unit: list[Bill],
    occ_map: dict[int, list[Occupancy]],
    payments_for_unit: dict[tuple[int, int, str], float],
) -> dict:
    """Build one section dict (consumed by build_statement_pdf) for a unit+occupancy pair.

    occ_map: occupancies keyed by unit id, covering every unit that appears on any of
    bills_for_unit's assignments (the target unit AND its co-assignees) so split_bill
    can compute the correct per-unit share.
    """
    # Group bills by due (year, month) — only bills overlapping the selected occupancy.
    by_month: dict[tuple[int, int], dict[str, _CellAgg]] = defaultdict(lambda: defaultdict(_CellAgg))
    # Also track unit-level owed totals per month/kind for proportional payment attribution.
    unit_owed_by_mk: dict[tuple[int, int, str], float] = defaultdict(float)

    for bill in bills_for_unit:
        if _overlap_days(
            occupancy.start_date, occupancy.end_date, bill.start_date, bill.end_date
        ) == 0:
            continue
        due = bill_due_date(bill.end_date)
        key = (due.year, due.month)
        occ_share, unit_share = _attribute_to_occupancy(
            bill, unit.id, occupancy, occ_map
        )
        by_month[key][bill.kind].owed += occ_share
        unit_owed_by_mk[(due.year, due.month, bill.kind)] += unit_share

    # Attribute payments proportionally.
    for (y, m), cats in by_month.items():
        for kind, cell in cats.items():
            unit_owed = unit_owed_by_mk.get((y, m, kind), 0.0)
            unit_paid = payments_for_unit.get((y, m, kind), 0.0)
            if unit_owed > 0:
                cell.paid = unit_paid * (cell.owed / unit_owed)
            # If unit_owed is 0 we'd be dividing by zero; leave paid at 0 (no contribution).

    months_out = []
    total_owed = total_paid = 0.0
    for key in sorted(by_month.keys()):
        year, month = key
        cats = by_month[key]
        rows = []
        sub_owed = sub_paid = 0.0
        for kind in sorted(cats.keys()):
            owed = round(cats[kind].owed, 2)
            paid = round(cats[kind].paid, 2)
            rows.append((kind, owed, paid))
            sub_owed += owed
            sub_paid += paid
        if rows:
            months_out.append({
                "year": year,
                "month": month,
                "rows": rows,
                "subtotal_owed": round(sub_owed, 2),
                "subtotal_paid": round(sub_paid, 2),
                "subtotal_remaining": round(sub_owed - sub_paid, 2),
            })
            total_owed += sub_owed
            total_paid += sub_paid

    return {
        "title": f"{unit.name}",
        "subtitle": (
            f"{occupancy.tenant_count} tenant{'s' if occupancy.tenant_count != 1 else ''} "
            f"— {occupancy.start_date} to {occupancy.end_date} (inclusive)"
        ),
        "months": months_out,
        "total_owed": round(total_owed, 2),
        "total_paid": round(total_paid, 2),
        "total_outstanding": round(total_owed - total_paid, 2),
    }
