/**
 * Record / edit a payment for one dashboard cell (unit, year, month, kind).
 *
 * Route: #payment/<unitId>/<year>/<month>/<kind>
 *
 * Payments are unique per (unit_id, year, month, kind); saving upserts. The
 * "owed" prefill is recomputed from current bills + occupancies so it matches
 * the dashboard cell.
 */
import {
  appendRow, deleteRow, invalidate, nextId, readAll, updateRow,
} from "../sheets.js";
import { splitBill } from "../billing.js";
import {
  asFloat, asInt, asOptInt, clear, effectiveDueDate, flash, fmtMoney, h,
  MONTH_NAMES, parseDate,
} from "../util.js";

export default async function mountPaymentForm(container, params) {
  const [uidStr, yearStr, monthStr, ...kindParts] = params;
  const uid = parseInt(uidStr, 10);
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const kind = decodeURIComponent(kindParts.join("/"));

  clear(container);
  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const unit = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "" }))
    .find((u) => u.id === uid);
  if (!unit) {
    window.location.hash = "#dashboard";
    return;
  }

  const existing = (data.payments || [])
    .map((r) => ({
      id: asInt(r.id), unit_id: asInt(r.unit_id), year: asInt(r.year),
      month: asInt(r.month), kind: r.kind || "", amount: asFloat(r.amount),
    }))
    .find((p) => p.unit_id === uid && p.year === year &&
                 p.month === month && p.kind === kind);

  const owed = _computeOwed(data, uid, year, month, kind);

  container.appendChild(h("h1", null, existing ? "Edit payment" : "Record payment"));
  container.appendChild(h("p", { class: "muted" },
    `${unit.name} · ${kind} · ${year}-${String(month).padStart(2, "0")}`,
    h("br"),
    "Total owed: ", h("strong", null, fmtMoney(owed))));

  const amountInput = h("input", {
    type: "number", step: "0.01", min: "0", name: "amount", required: true,
    value: existing ? existing.amount.toFixed(2) : owed.toFixed(2),
  });
  const form = h("form", { id: "paymentform" },
    h("label", null, "Amount paid ($)", amountInput));
  container.appendChild(form);

  const saveBtn = h("button", { class: "btn", type: "submit", form: "paymentform" }, "Save");
  container.appendChild(h("div", { class: "sticky-save" },
    saveBtn,
    h("a", { class: "btn-secondary", href: "#dashboard" }, "Cancel"),
  ));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    try {
      const amount = parseFloat(amountInput.value);
      // A $0 payment means "no payment" — keep the sheet free of dead rows.
      if (existing && amount === 0) {
        await deleteRow("payments", existing.id);
        flash(`Cleared payment for ${unit.name} (${kind}).`);
      } else if (existing) {
        await updateRow("payments", existing.id, { amount });
        flash(`Updated payment for ${unit.name} (${kind}).`);
      } else if (amount === 0) {
        flash(`No payment recorded for ${unit.name} (${kind}).`);
      } else {
        const fresh = await readAll();
        const newId = nextId(fresh.payments || []);
        await appendRow("payments", {
          id: newId, unit_id: uid, year, month, kind, amount,
        });
        flash(`Recorded ${fmtMoney(amount)} payment for ${unit.name} (${kind}).`);
      }
      invalidate("payments");
      window.location.hash = "#dashboard";
    } catch (err) {
      flash(`Save failed: ${err.message}`, "err");
    } finally {
      saveBtn.disabled = false;
    }
  });
}

function _computeOwed(data, unitId, year, month, kind) {
  const units = new Map((data.units || []).map((r) => [asInt(r.id), r.name || ""]));
  const assignsByBill = new Map();
  for (const r of (data.bill_units || [])) {
    const bid = asInt(r.bill_id);
    if (!assignsByBill.has(bid)) assignsByBill.set(bid, []);
    assignsByBill.get(bid).push(asInt(r.unit_id));
  }
  // Bills of this kind whose due date is (year, month).
  const bills = (data.bills || [])
    .map((r) => ({
      id: asInt(r.id), kind: r.kind || "", amount: asFloat(r.amount),
      start_date: parseDate(r.start_date), end_date: parseDate(r.end_date),
      recurring_bill_id: asOptInt(r.recurring_bill_id),
      due_date: r.due_date || "",
    }))
    .filter((b) => b.kind === kind && b.start_date && b.end_date)
    .filter((b) => {
      const due = effectiveDueDate(b);
      return due.getUTCFullYear() === year && due.getUTCMonth() + 1 === month;
    });
  if (!bills.length) return 0;

  const relatedUnitIds = new Set();
  for (const b of bills) for (const uid of (assignsByBill.get(b.id) || [])) relatedUnitIds.add(uid);
  const occMap = {};
  for (const r of (data.occupancies || [])) {
    const uid = asInt(r.unit_id);
    if (!relatedUnitIds.has(uid)) continue;
    if (!occMap[uid]) occMap[uid] = [];
    occMap[uid].push({
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date),
      end_date: parseDate(r.end_date),
    });
  }

  let total = 0;
  for (const b of bills) {
    b.assignments = (assignsByBill.get(b.id) || []).map((uid) => ({
      unit_id: uid, unit: { id: uid, name: units.get(uid) || "" },
    }));
    for (const sh of splitBill(b, occMap)) {
      if (sh.unit_id === unitId) total += sh.amount;
    }
  }
  return Math.round(total * 100) / 100;
}
