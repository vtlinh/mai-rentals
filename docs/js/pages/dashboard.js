/**
 * Dashboard: outstanding balance + per-month totals.
 *
 * Reads all tabs once via readAll(), applies recurring-bill generation in
 * the background (so the dashboard reflects entries due as of today), then
 * groups bills by due month and computes per-unit owed/paid/remaining.
 */
import { recurringInstances, splitBill } from "../billing.js";
import {
  appendRow, readAll, nextId,
} from "../sheets.js";
import {
  asBool, asFloat, asInt, asOptInt, clear, effectiveDueDate, fmtMoney, h,
  MONTH_NAMES, parseDate, today,
} from "../util.js";

export default async function mountDashboard(container) {
  clear(container);
  container.appendChild(h("h1", null, "Dashboard"));
  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  await _applyRecurring(data);

  clear(container);
  _render(container, data);
}

/**
 * For each active recurring template, append any missing Bill rows up to
 * today. Deduplicates by (recurring_bill_id, start_date). Mutates the
 * in-memory bills cache so the immediate render reflects the new rows.
 */
async function _applyRecurring(data) {
  const t = today();
  const rbs = (data.recurring_bills || []).map(_parseRecurring);
  const existingBills = (data.bills || []).map(_parseBill);
  const writes = [];
  for (const rb of rbs) {
    if (!rb.active || !rb.start_date) continue;
    const existingStarts = new Set(
      existingBills.filter((b) => b.recurring_bill_id === rb.id && b.start_date)
        .map((b) => b.start_date.toISOString().slice(0, 10))
    );
    const unitIds = (data.recurring_bill_units || [])
      .filter((r) => asInt(r.recurring_bill_id) === rb.id)
      .map((r) => asInt(r.unit_id));
    const amount = rb.is_credit ? -rb.amount : rb.amount;
    for (const [start, end] of recurringInstances(rb, t)) {
      const key = start.toISOString().slice(0, 10);
      if (existingStarts.has(key)) continue;
      const newBillId = nextId(data.bills);
      // "start" timing → the bill is due within its own period (stamp the
      // period start as the due date); "end" (default) → leave blank so it
      // derives to the 1st of the following month.
      const dueDate = rb.bill_timing === "start" ? key : "";
      data.bills.push({
        id: String(newBillId), kind: rb.kind, amount: String(amount),
        start_date: key, end_date: end.toISOString().slice(0, 10),
        note: rb.note || "", recurring_bill_id: String(rb.id), due_date: dueDate,
      });
      writes.push({ tab: "bills", row: {
        id: newBillId, kind: rb.kind, amount, start_date: key,
        end_date: end.toISOString().slice(0, 10), note: rb.note || "",
        recurring_bill_id: rb.id, due_date: dueDate,
      }});
      existingStarts.add(key);
      for (const uid of unitIds) {
        const buId = nextId(data.bill_units);
        data.bill_units.push({
          id: String(buId), bill_id: String(newBillId), unit_id: String(uid),
        });
        writes.push({ tab: "bill_units", row: {
          id: buId, bill_id: newBillId, unit_id: uid,
        }});
      }
    }
  }
  // Write sequentially and stop on the first failure: bill_units rows
  // reference bills appended just before them, and a reload that races
  // in-flight appends would re-generate the same periods (duplicates).
  try {
    for (const w of writes) await appendRow(w.tab, w.row);
  } catch (err) {
    console.warn("recurring write failed; will retry next load", err);
  }
}

function _render(container, data) {
  const units = (data.units || []).map(_parseUnit);
  const occMap = _occMap(data.occupancies || []);
  // Rows with unparseable dates can't be split or bucketed by due month;
  // they still show on the Bills page where they can be edited.
  const bills = (data.bills || []).map(_parseBill)
    .filter((b) => b.start_date && b.end_date);
  const payments = (data.payments || []).map(_parsePayment);
  const unitsById = new Map(units.map((u) => [u.id, u]));

  // Attach assignments to each bill (and join unit refs onto each assignment).
  const billAssignments = new Map();
  for (const r of (data.bill_units || [])) {
    const bid = asInt(r.bill_id), uid = asInt(r.unit_id);
    if (!billAssignments.has(bid)) billAssignments.set(bid, []);
    billAssignments.get(bid).push({
      unit_id: uid,
      unit: unitsById.get(uid) || { id: uid, name: `unit ${uid}` },
    });
  }
  for (const b of bills) b.assignments = billAssignments.get(b.id) || [];

  // Outstanding by unit name across all months.
  const outstanding = new Map();

  // Bucket bills by (year, month) of their due date.
  const byMonth = new Map();
  for (const b of bills) {
    const due = effectiveDueDate(b);
    const key = `${due.getUTCFullYear()}-${String(due.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(key)) {
      byMonth.set(key, {
        year: due.getUTCFullYear(),
        month: due.getUTCMonth() + 1,
        bills: [],
      });
    }
    byMonth.get(key).bills.push(b);
  }

  // Don't surface amounts owed for months that haven't arrived yet. A bill
  // billed "at end" of, say, July is due Aug 1 — but while it's still July we
  // shouldn't show (or count toward outstanding) an August balance. Keep only
  // due months up to and including the current one.
  const t = today();
  const curY = t.getUTCFullYear(), curM = t.getUTCMonth() + 1;
  const months = [...byMonth.values()]
    .filter((m) => m.year < curY || (m.year === curY && m.month <= curM))
    .sort((a, b) => (b.year - a.year) || (b.month - a.month));

  // Outstanding balance section ------------------------------------
  // (We compute it as a side-effect of rendering each month, so render months first.)
  const outstandingHeader = h("h2", null, "Outstanding balance");
  const outstandingTable = h("table");
  const outstandingTbody = h("tbody");
  outstandingTable.appendChild(h("thead", null,
    h("tr", null,
      h("th", null, "Unit"),
      h("th", { class: "right" }, "Still owes"),
    )
  ));
  outstandingTable.appendChild(outstandingTbody);

  container.appendChild(h("p", { class: "actions" },
    h("a", { class: "btn", href: "#pdf" }, "Generate PDF")));
  container.appendChild(outstandingHeader);
  container.appendChild(outstandingTable);

  const monthsHeader = h("h2", null, "Amounts owed by month");
  container.appendChild(monthsHeader);

  if (!months.length) {
    container.appendChild(h("div", { class: "empty-state" },
      h("p", null, "No bills yet."),
      h("a", { class: "btn", href: "#bills/new" }, "+ Add a bill")));
  }

  for (const m of months) {
    const section = h("section", { style: { marginBottom: "2rem" } });
    section.appendChild(h("h3", null, `${m.year}-${String(m.month).padStart(2, "0")}`));

    // totals[unit_name][kind] = owed
    const totals = new Map();
    const kindsPresent = new Set();
    const billRows = [];

    for (const b of m.bills.sort((a, b) => a.kind.localeCompare(b.kind)
                                          || a.end_date - b.end_date)) {
      const shares = splitBill(b, occMap);
      const billTotal = shares.reduce((s, sh) => s + sh.amount, 0);
      billRows.push({ bill: b, total: billTotal });
      kindsPresent.add(b.kind);
      for (const sh of shares) {
        if (!totals.has(sh.unit_name)) totals.set(sh.unit_name, new Map());
        const byKind = totals.get(sh.unit_name);
        byKind.set(b.kind, (byKind.get(b.kind) || 0) + sh.amount);
      }
    }
    const kindsSorted = [...kindsPresent].sort();

    // Per-unit totals table
    const tbl = h("table");
    const headRow = h("tr", null, h("th", null, "Unit"));
    for (const k of kindsSorted) headRow.appendChild(h("th", { class: "right" }, k));
    headRow.appendChild(h("th", { class: "right" }, "Total"));
    tbl.appendChild(headRow);

    const unitNamesSorted = [...totals.keys()].sort();
    let anyRow = false;
    for (const name of unitNamesSorted) {
      const byKind = totals.get(name);
      let rowTotal = 0;
      for (const v of byKind.values()) rowTotal += v;
      if (Math.round(rowTotal * 100) === 0) continue;
      anyRow = true;
      const u = units.find((x) => x.name === name);
      const row = h("tr", null, h("td", null, name));
      for (const k of kindsSorted) {
        const owed = Math.round((byKind.get(k) || 0) * 100) / 100;
        const payment = u ? payments.find((p) =>
          p.unit_id === u.id && p.year === m.year && p.month === m.month && p.kind === k) : null;
        const paid = payment ? Math.round(payment.amount * 100) / 100 : 0;
        const remaining = Math.round((owed - paid) * 100) / 100;
        const cell = h("td", { class: "right" });
        if (owed) {
          cell.appendChild(document.createTextNode(fmtMoney(owed)));
          if (u) {
            cell.appendChild(document.createTextNode(" "));
            cell.appendChild(h("a", {
              class: "btn-secondary btn-sm",
              href: `#payment/${u.id}/${m.year}/${m.month}/${encodeURIComponent(k)}`,
            }, payment ? "edit" : "pay"));
          }
          cell.appendChild(h("br"));
          if (remaining <= 0) {
            cell.appendChild(h("span",
              { style: { color: "var(--accent-green)", fontSize: "0.85em" } },
              "(paid)"));
          } else {
            cell.appendChild(h("span",
              { style: { color: "var(--accent-orange)", fontSize: "0.85em" } },
              `(remaining: ${fmtMoney(remaining)})`));
          }
          if (owed > 0) {
            outstanding.set(name,
              (outstanding.get(name) || 0) + Math.max(remaining, 0));
          }
        } else {
          cell.textContent = "—";
        }
        row.appendChild(cell);
      }
      row.appendChild(h("td", { class: "right" },
        h("strong", null, fmtMoney(Math.round(rowTotal * 100) / 100))));
      tbl.appendChild(row);
    }
    if (anyRow) section.appendChild(tbl);
    else section.appendChild(h("p", { class: "muted" }, "No units owe money this month."));

    // Bills-due list
    section.appendChild(h("h4", null, "Bills due"));
    const ul = h("ul");
    for (const row of billRows) {
      const li = h("li", null,
        `${row.bill.kind} — ${fmtMoney(row.bill.amount)}`,
      );
      const meta = ` (period ${row.bill.start_date.toISOString().slice(0,10)} ` +
                   `to ${row.bill.end_date.toISOString().slice(0,10)}` +
                   (row.bill.note ? `, ${row.bill.note}` : "") + ")";
      li.appendChild(h("span", { class: "muted" }, meta));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    container.appendChild(section);
  }

  // Now fill in outstanding totals.
  const rows = [...outstanding.entries()]
    .filter(([_, v]) => Math.round(v * 100) > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (!rows.length) {
    clear(outstandingTbody);
    outstandingTable.style.display = "none";
    outstandingHeader.after(h("p",
      { style: { color: "var(--accent-green)" } },
      "No outstanding balance for any units."));
  } else {
    for (const [name, amt] of rows) {
      outstandingTbody.appendChild(h("tr", null,
        h("td", null, name),
        h("td", { class: "right" },
          h("strong", null, fmtMoney(Math.round(amt * 100) / 100))),
      ));
    }
  }
}

// ---------------- Row parsing ----------------

function _parseUnit(r) {
  return { id: asInt(r.id), name: r.name || "", note: r.note || "" };
}

function _parseOccupancy(r) {
  return {
    id: asInt(r.id), unit_id: asInt(r.unit_id),
    tenant_count: asInt(r.tenant_count),
    start_date: parseDate(r.start_date),
    end_date: parseDate(r.end_date),
  };
}

function _parseBill(r) {
  return {
    id: asInt(r.id), kind: r.kind || "", amount: asFloat(r.amount),
    start_date: parseDate(r.start_date),
    end_date: parseDate(r.end_date),
    note: r.note || "",
    recurring_bill_id: asOptInt(r.recurring_bill_id),
    due_date: r.due_date || "",
    assignments: [],
  };
}

function _parseRecurring(r) {
  return {
    id: asInt(r.id), kind: r.kind || "", amount: asFloat(r.amount),
    note: r.note || "", recurrence: r.recurrence || "monthly",
    recurrence_config: r.recurrence_config || "",
    start_date: parseDate(r.start_date),
    end_date: r.end_date ? parseDate(r.end_date) : null,
    active: asBool(r.active, true),
    is_credit: asBool(r.is_credit, false),
    bill_timing: (r.bill_timing || "end").trim() || "end",
  };
}

function _parsePayment(r) {
  return {
    id: asInt(r.id), unit_id: asInt(r.unit_id),
    year: asInt(r.year), month: asInt(r.month),
    kind: r.kind || "", amount: asFloat(r.amount),
  };
}

function _occMap(rows) {
  const out = {};
  for (const r of rows) {
    const o = _parseOccupancy(r);
    if (!out[o.unit_id]) out[o.unit_id] = [];
    out[o.unit_id].push(o);
  }
  return out;
}
