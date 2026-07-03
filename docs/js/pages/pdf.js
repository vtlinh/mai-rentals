/**
 * Generate PDF statements.
 *
 * Route: #pdf
 *
 * Picker lists each unit with a checkbox per occupancy (single-occupancy units
 * show one box; multi-occupancy units expose each tenant set). On generate we
 * build one section per selection and render a PDF via pdfmake (loaded from
 * CDN). Per-occupancy attribution mirrors app/pdf.py:
 *   • a bill's unit-share (from splitBill) is apportioned across that unit's
 *     occupancies by person-days overlapping the bill period
 *   • unit-level payments are attributed to occupancies proportionally to the
 *     occupancy's share of the month's owed total
 */
import { coversKind, splitBill, unitPersonDays } from "../billing.js";
import { readAll } from "../sheets.js";
import {
  asFloat, asInt, asOptInt, clear, effectiveDueDate, flash, h, MONTH_NAMES,
  overlapDays, parseDate, today,
} from "../util.js";

const PDFMAKE_JS = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/pdfmake.min.js";
const PDFMAKE_FONTS = "https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.10/vfs_fonts.js";

export default async function mountPdf(container) {
  clear(container);
  container.appendChild(h("h1", null, "Generate PDF statement"));
  container.appendChild(h("p", { class: "muted" },
    "Pick which units (and tenant sets) to include. One PDF will be generated " +
    "with a section per selection."));

  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const units = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const occsByUnit = new Map();
  for (const r of (data.occupancies || [])) {
    const uid = asInt(r.unit_id);
    if (!occsByUnit.has(uid)) occsByUnit.set(uid, []);
    occsByUnit.get(uid).push({
      id: asInt(r.id),
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date),
      end_date: parseDate(r.end_date),
    });
  }

  const form = h("form", { id: "pdfform" });
  if (!units.length) {
    form.appendChild(h("div", { class: "empty-state" },
      h("p", null, "No units yet.")));
  }
  for (const u of units) {
    const fs = h("fieldset",
      { style: { margin: "1rem 0", padding: "0.5rem 1rem", border: "1px solid var(--border)", borderRadius: "6px" } },
      h("legend", null, h("strong", null, u.name)));
    const occs = (occsByUnit.get(u.id) || []).sort((a, b) => a.start_date - b.start_date);
    if (!occs.length) {
      fs.appendChild(h("p", { class: "muted" }, "No occupancies on file — nothing to statement."));
    } else {
      if (occs.length > 1) {
        fs.appendChild(h("p", { class: "muted", style: { marginTop: "0" } },
          "This unit has multiple tenant sets — pick the ones to include:"));
      }
      for (const o of occs) {
        const cb = h("input", {
          type: "checkbox", name: "selection", value: `${u.id}:${o.id}`,
        });
        fs.appendChild(h("label", { style: { display: "block" } },
          cb, " ",
          `${o.tenant_count} tenant${o.tenant_count === 1 ? "" : "s"} ` +
          `(${o.start_date.toISOString().slice(0,10)} to ${o.end_date.toISOString().slice(0,10)})`));
      }
    }
    form.appendChild(fs);
  }
  container.appendChild(form);

  const genBtn = h("button", { class: "btn", type: "submit", form: "pdfform" }, "Generate PDF");
  container.appendChild(h("div", { class: "sticky-save" },
    genBtn,
    h("a", { class: "btn-secondary", href: "#dashboard" }, "Cancel"),
  ));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const pairs = [...form.querySelectorAll("input[name='selection']:checked")]
      .map((cb) => cb.value.split(":").map((x) => parseInt(x, 10)));
    if (!pairs.length) {
      flash("Pick at least one unit/tenant set to generate a PDF.", "err");
      return;
    }
    genBtn.disabled = true;
    genBtn.textContent = "Generating…";
    try {
      const sections = _buildSections(data, pairs);
      await _renderPdf(sections);
    } catch (err) {
      console.error(err);
      flash(`PDF failed: ${err.message}`, "err");
    } finally {
      genBtn.disabled = false;
      genBtn.textContent = "Generate PDF";
    }
  });
}

// ---------------- Section building (port of pdf.py) ----------------

function _buildSections(data, pairs) {
  const unitsById = new Map((data.units || []).map((r) => [asInt(r.id), r.name || ""]));
  const occById = new Map();
  const occByUnit = new Map();
  for (const r of (data.occupancies || [])) {
    const o = {
      id: asInt(r.id), unit_id: asInt(r.unit_id),
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date), end_date: parseDate(r.end_date),
      covered_kinds: r.covered_kinds || "",
    };
    occById.set(o.id, o);
    if (!occByUnit.has(o.unit_id)) occByUnit.set(o.unit_id, []);
    occByUnit.get(o.unit_id).push(o);
  }
  const assignsByBill = new Map();
  for (const r of (data.bill_units || [])) {
    const bid = asInt(r.bill_id);
    if (!assignsByBill.has(bid)) assignsByBill.set(bid, []);
    assignsByBill.get(bid).push(asInt(r.unit_id));
  }
  const billsByUnit = new Map();
  const allBills = (data.bills || []).map((r) => ({
    id: asInt(r.id), kind: r.kind || "", amount: asFloat(r.amount),
    start_date: parseDate(r.start_date), end_date: parseDate(r.end_date),
    note: r.note || "", recurring_bill_id: asOptInt(r.recurring_bill_id),
    due_date: r.due_date || "",
  })).filter((b) => b.start_date && b.end_date);
  const billById = new Map(allBills.map((b) => [b.id, b]));
  for (const [bid, uids] of assignsByBill) {
    for (const uid of uids) {
      if (!billsByUnit.has(uid)) billsByUnit.set(uid, []);
      const b = billById.get(bid);
      if (b) billsByUnit.get(uid).push(b);
    }
  }
  const paymentsByUnit = new Map();
  for (const r of (data.payments || [])) {
    const uid = asInt(r.unit_id);
    if (!paymentsByUnit.has(uid)) paymentsByUnit.set(uid, new Map());
    paymentsByUnit.get(uid).set(
      `${asInt(r.year)}-${asInt(r.month)}-${r.kind || ""}`, asFloat(r.amount));
  }

  const sections = [];
  for (const [uid, oid] of pairs) {
    const occ = occById.get(oid);
    if (!occ || occ.unit_id !== uid) continue;
    const billsForUnit = billsByUnit.get(uid) || [];
    // occMap must cover every unit on those bills, not just the target.
    const relatedUnitIds = new Set([uid]);
    for (const b of billsForUnit) for (const u of (assignsByBill.get(b.id) || [])) relatedUnitIds.add(u);
    const occMap = {};
    for (const u of relatedUnitIds) occMap[u] = occByUnit.get(u) || [];
    // attach assignments (with unit refs) to each bill so splitBill works
    for (const b of billsForUnit) {
      b.assignments = (assignsByBill.get(b.id) || []).map((u) => ({
        unit_id: u, unit: { id: u, name: unitsById.get(u) || "" },
      }));
    }
    sections.push(_buildSection(
      { id: uid, name: unitsById.get(uid) || "" },
      occ, billsForUnit, occMap, paymentsByUnit.get(uid) || new Map(),
    ));
  }
  return sections;
}

function _buildSection(unit, occupancy, billsForUnit, occMap, paymentsForUnit) {
  const byMonth = new Map();        // "y-m" → Map(kind → {owed, paid})
  const unitOwedByMK = new Map();   // "y-m-kind" → unit_share total
  const now = today();
  const curYM = now.getUTCFullYear() * 12 + now.getUTCMonth();

  for (const bill of billsForUnit) {
    if (overlapDays(occupancy.start_date, occupancy.end_date,
                    bill.start_date, bill.end_date) === 0) continue;
    const due = effectiveDueDate(bill);
    const y = due.getUTCFullYear(), m = due.getUTCMonth() + 1;
    // Statements only cover months due so far — skip future months.
    if (y * 12 + (m - 1) > curYM) continue;
    const key = `${y}-${m}`;

    const shares = splitBill(bill, occMap);
    const unitShare = (shares.find((s) => s.unit_id === unit.id) || {}).amount || 0;
    let occShare = 0;
    if (unitShare !== 0) {
      const allOccs = occMap[unit.id] || [];
      const targetPd = overlapDays(occupancy.start_date, occupancy.end_date,
        bill.start_date, bill.end_date) * occupancy.tenant_count;
      const totalPd = unitPersonDays(allOccs, bill);
      occShare = totalPd > 0 ? unitShare * (targetPd / totalPd) : 0;
    }

    if (!byMonth.has(key)) byMonth.set(key, { y, m, cats: new Map() });
    const cats = byMonth.get(key).cats;
    if (!cats.has(bill.kind)) cats.set(bill.kind, { owed: 0, paid: 0, covered: 0 });
    cats.get(bill.kind).owed += occShare;
    // Kinds covered by this tenancy's contract count as paid automatically.
    if (coversKind(occupancy, bill.kind)) cats.get(bill.kind).covered += occShare;
    const mk = `${y}-${m}-${bill.kind}`;
    unitOwedByMK.set(mk, (unitOwedByMK.get(mk) || 0) + unitShare);
  }

  // Attribute payments proportionally, then add auto-covered amounts.
  for (const { y, m, cats } of byMonth.values()) {
    for (const [kind, cell] of cats) {
      const unitOwed = unitOwedByMK.get(`${y}-${m}-${kind}`) || 0;
      const unitPaid = paymentsForUnit.get(`${y}-${m}-${kind}`) || 0;
      if (unitOwed > 0) cell.paid = unitPaid * (cell.owed / unitOwed);
      cell.paid += cell.covered;
    }
  }

  const months = [];
  let totalOwed = 0, totalPaid = 0;
  const keys = [...byMonth.keys()].sort((a, b) => {
    const [ay, am] = a.split("-").map(Number), [by, bm] = b.split("-").map(Number);
    return ay - by || am - bm;
  });
  for (const key of keys) {
    const { y, m, cats } = byMonth.get(key);
    const rows = [];
    let subOwed = 0, subPaid = 0;
    for (const kind of [...cats.keys()].sort()) {
      const owed = Math.round(cats.get(kind).owed * 100) / 100;
      const paid = Math.round(cats.get(kind).paid * 100) / 100;
      rows.push({ kind, owed, paid });
      subOwed += owed; subPaid += paid;
    }
    if (rows.length) {
      months.push({
        year: y, month: m, rows,
        subtotalOwed: Math.round(subOwed * 100) / 100,
        subtotalPaid: Math.round(subPaid * 100) / 100,
        subtotalRemaining: Math.round((subOwed - subPaid) * 100) / 100,
      });
      totalOwed += subOwed; totalPaid += subPaid;
    }
  }

  return {
    title: unit.name,
    subtitle: `${occupancy.tenant_count} tenant${occupancy.tenant_count === 1 ? "" : "s"} — ` +
              `${occupancy.start_date.toISOString().slice(0,10)} to ` +
              `${occupancy.end_date.toISOString().slice(0,10)} (inclusive)`,
    months,
    totalOwed: Math.round(totalOwed * 100) / 100,
    totalPaid: Math.round(totalPaid * 100) / 100,
    totalOutstanding: Math.round((totalOwed - totalPaid) * 100) / 100,
  };
}

// ---------------- PDF rendering (pdfmake) ----------------

let _pdfmakeReady = null;
function _loadPdfmake() {
  if (_pdfmakeReady) return _pdfmakeReady;
  _pdfmakeReady = new Promise((resolve, reject) => {
    const s1 = document.createElement("script");
    s1.src = PDFMAKE_JS;
    s1.onload = () => {
      const s2 = document.createElement("script");
      s2.src = PDFMAKE_FONTS;
      s2.onload = () => resolve();
      s2.onerror = () => reject(new Error("failed to load pdfmake fonts"));
      document.head.appendChild(s2);
    };
    s1.onerror = () => reject(new Error("failed to load pdfmake"));
    document.head.appendChild(s1);
  });
  return _pdfmakeReady;
}

const money = (n) => `$${n.toFixed(2)}`;

async function _renderPdf(sections) {
  await _loadPdfmake();
  const content = [
    { text: "Rental statement", style: "h1" },
    { text: `Generated ${today().toISOString().slice(0, 10)}`, color: "gray", margin: [0, 0, 0, 12] },
  ];

  sections.forEach((sec, i) => {
    if (i > 0) content.push({ text: "", pageBreak: "before" });
    content.push({ text: sec.title, style: "h2", margin: [0, 4, 0, 0] });
    content.push({ text: sec.subtitle, color: "gray", margin: [0, 0, 0, 8] });

    if (!sec.months.length) {
      content.push({ text: "No bills in scope.", margin: [0, 0, 0, 8] });
    } else {
      for (const m of sec.months) {
        content.push({ text: `${MONTH_NAMES[m.month - 1]} ${m.year}`, style: "h3", margin: [0, 6, 0, 4] });
        const body = [[
          { text: "Category", bold: true, fillColor: "#f4f4f4" },
          { text: "Owed", bold: true, alignment: "right", fillColor: "#f4f4f4" },
          { text: "Paid", bold: true, alignment: "right", fillColor: "#f4f4f4" },
          { text: "Remaining", bold: true, alignment: "right", fillColor: "#f4f4f4" },
        ]];
        for (const row of m.rows) {
          body.push([
            row.kind,
            { text: money(row.owed), alignment: "right" },
            { text: money(row.paid), alignment: "right" },
            { text: money(row.owed - row.paid), alignment: "right" },
          ]);
        }
        body.push([
          { text: "Total", bold: true },
          { text: money(m.subtotalOwed), alignment: "right", bold: true },
          { text: money(m.subtotalPaid), alignment: "right", bold: true },
          { text: money(m.subtotalRemaining), alignment: "right", bold: true },
        ]);
        content.push({
          table: { headerRows: 1, widths: ["*", "auto", "auto", "auto"], body },
          layout: "lightHorizontalLines", margin: [0, 0, 0, 8],
        });
      }
    }
    content.push({
      table: {
        widths: ["*", "auto"],
        body: [
          ["Total owed", { text: money(sec.totalOwed), alignment: "right" }],
          ["Total paid", { text: money(sec.totalPaid), alignment: "right" }],
          [{ text: "Outstanding balance", bold: true },
           { text: money(sec.totalOutstanding), alignment: "right", bold: true }],
        ],
      },
      layout: "noBorders", margin: [0, 6, 0, 0],
    });
  });

  const docDefinition = {
    content,
    styles: {
      h1: { fontSize: 20, bold: true },
      h2: { fontSize: 15, bold: true },
      h3: { fontSize: 12, bold: true },
    },
    defaultStyle: { fontSize: 10 },
    pageMargins: [40, 40, 40, 40],
  };
  const filename = `statement-${today().toISOString().slice(0, 10)}.pdf`;
  window.pdfMake.createPdf(docDefinition).download(filename);
}
