/**
 * Cross-tab consistency: cascading deletes, category renames, and cleanup of
 * payments made redundant by covered utilities. sheets.js stays
 * schema-agnostic; this module owns the foreign-key graph:
 *   recurring_bills → bills (generated) → bill_units
 *   recurring_bills → recurring_bill_units
 *   units → occupancies / bill_units / recurring_bill_units / payments
 *
 * Each tab is cleared with one batched deleteRows call; child tabs go
 * before their parents so a mid-cascade failure never orphans references.
 */
import { deleteRow, deleteRows, invalidate, updateRows } from "./sheets.js";
import { coveredFraction } from "./billing.js";
import {
  asInt, asOptInt, effectiveDueDate, parseDate, parseNamesCsv,
} from "./util.js";

/**
 * Delete a recurring template and everything it spawned: its generated bills,
 * those bills' unit assignments, and its own unit assignments.
 */
export async function deleteRecurringCascade(rid, data) {
  const billIds = (data.bills || [])
    .filter((b) => asOptInt(b.recurring_bill_id) === rid)
    .map((b) => asInt(b.id));
  const billIdSet = new Set(billIds);
  const buIds = (data.bill_units || [])
    .filter((bu) => billIdSet.has(asInt(bu.bill_id)))
    .map((bu) => asInt(bu.id));
  const rbuIds = (data.recurring_bill_units || [])
    .filter((r) => asInt(r.recurring_bill_id) === rid)
    .map((r) => asInt(r.id));
  await deleteRows("bill_units", buIds);
  await deleteRows("bills", billIds);
  await deleteRows("recurring_bill_units", rbuIds);
  await deleteRow("recurring_bills", rid);
  invalidate();
}

/** Delete a unit and every row that references it. */
export async function deleteUnitCascade(uid, data) {
  const idsIn = (tab) => (data[tab] || [])
    .filter((r) => asInt(r.unit_id) === uid)
    .map((r) => asInt(r.id));
  await deleteRows("occupancies", idsIn("occupancies"));
  await deleteRows("bill_units", idsIn("bill_units"));
  await deleteRows("recurring_bill_units", idsIn("recurring_bill_units"));
  await deleteRows("payments", idsIn("payments"));
  await deleteRow("units", uid);
  invalidate();
}

/**
 * Delete a unit's payment rows made redundant by covered utilities. A payment
 * cell (year, month, kind) is redundant when the unit has at least one bill of
 * that kind due that month and every such bill is fully auto-covered
 * (coveredFraction == 1) — the dashboard already counts those as paid without
 * a payment row. Partially covered cells keep their payments (still needed
 * for the uncovered remainder). Returns the number of rows deleted.
 */
export async function removeCoveredPayments(uid, data) {
  const occs = (data.occupancies || [])
    .filter((r) => asInt(r.unit_id) === uid)
    .map((r) => ({
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date),
      end_date: parseDate(r.end_date),
      covered_kinds: parseNamesCsv(r.covered_kinds),
    }));
  if (!occs.some((o) => o.covered_kinds.length)) return 0;
  const payments = (data.payments || [])
    .filter((r) => asInt(r.unit_id) === uid)
    .map((r) => ({
      id: asInt(r.id), year: asInt(r.year), month: asInt(r.month),
      kind: r.kind || "",
    }));
  if (!payments.length) return 0;
  const assignedBillIds = new Set((data.bill_units || [])
    .filter((r) => asInt(r.unit_id) === uid)
    .map((r) => asInt(r.bill_id)));
  const bills = (data.bills || [])
    .map((r) => ({
      id: asInt(r.id), kind: r.kind || "",
      start_date: parseDate(r.start_date), end_date: parseDate(r.end_date),
      due_date: r.due_date || "",
    }))
    .filter((b) => assignedBillIds.has(b.id) && b.start_date && b.end_date);
  const doomed = [];
  for (const p of payments) {
    const cellBills = bills.filter((b) => {
      if (b.kind !== p.kind) return false;
      const due = effectiveDueDate(b);
      return due.getUTCFullYear() === p.year && due.getUTCMonth() + 1 === p.month;
    });
    // coveredFraction is covered/total person-days, both integer sums, so a
    // fully covered bill compares exactly equal to 1.
    if (cellBills.length &&
        cellBills.every((b) => coveredFraction(occs, b) === 1)) {
      doomed.push(p.id);
    }
  }
  await deleteRows("payments", doomed);
  return doomed.length;
}

/**
 * Rename a bill category everywhere the name is stored as data: bills.kind,
 * recurring_bills.kind, payments.kind, and occupancies.covered_kinds
 * (case-insensitive match). The categories row itself is the caller's to
 * update — after this succeeds, so a partial failure can be retried under the
 * old name. Returns per-tab rename counts.
 */
export async function renameKindCascade(oldName, newName, data) {
  const target = String(oldName).trim().toLowerCase();
  const matches = (v) => String(v || "").trim().toLowerCase() === target;
  const counts = {};
  for (const tab of ["bills", "recurring_bills", "payments"]) {
    const updates = (data[tab] || [])
      .filter((r) => matches(r.kind))
      .map((r) => [asInt(r.id), { kind: newName }]);
    await updateRows(tab, updates);
    counts[tab] = updates.length;
  }
  const occUpdates = [];
  for (const r of (data.occupancies || [])) {
    const kinds = parseNamesCsv(r.covered_kinds);
    if (!kinds.some(matches)) continue;
    const renamed = kinds.map((k) => (matches(k) ? newName : k));
    occUpdates.push([asInt(r.id), { covered_kinds: renamed.join(", ") }]);
  }
  await updateRows("occupancies", occUpdates);
  counts.occupancies = occUpdates.length;
  return counts;
}
