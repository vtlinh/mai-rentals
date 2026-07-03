/**
 * Cascading deletes across related tabs. sheets.js stays schema-agnostic;
 * this module owns the foreign-key graph:
 *   recurring_bills → bills (generated) → bill_units
 *   recurring_bills → recurring_bill_units
 *   units → occupancies / bill_units / recurring_bill_units / payments
 *
 * Each tab is cleared with one batched deleteRows call; child tabs go
 * before their parents so a mid-cascade failure never orphans references.
 */
import { deleteRow, deleteRows, invalidate } from "./sheets.js";
import { asInt, asOptInt } from "./util.js";

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
