/**
 * Cascading deletes across related tabs. sheets.js stays schema-agnostic;
 * this module owns the foreign-key graph:
 *   recurring_bills → bills (generated) → bill_units
 *   recurring_bills → recurring_bill_units
 *   units → occupancies / bill_units / recurring_bill_units / payments
 *
 * Deletes run sequentially (thunks, not live promises) to stay under
 * per-user Sheets batchUpdate rate limits.
 */
import { deleteRow, invalidate } from "./sheets.js";
import { asInt, asOptInt } from "./util.js";

/**
 * Delete a recurring template and everything it spawned: its generated bills,
 * those bills' unit assignments, and its own unit assignments.
 */
export async function deleteRecurringCascade(rid, data) {
  const tasks = [];
  for (const b of (data.bills || [])) {
    if (asOptInt(b.recurring_bill_id) === rid) {
      const bid = asInt(b.id);
      for (const bu of (data.bill_units || [])) {
        if (asInt(bu.bill_id) === bid) {
          const buId = asInt(bu.id);
          tasks.push(() => deleteRow("bill_units", buId));
        }
      }
      tasks.push(() => deleteRow("bills", bid));
    }
  }
  for (const r of (data.recurring_bill_units || [])) {
    if (asInt(r.recurring_bill_id) === rid) {
      const rowId = asInt(r.id);
      tasks.push(() => deleteRow("recurring_bill_units", rowId));
    }
  }
  for (const t of tasks) await t();
  await deleteRow("recurring_bills", rid);
  invalidate();
}

/** Delete a unit and every row that references it. */
export async function deleteUnitCascade(uid, data) {
  const tasks = [];
  const queue = (tab, idAttr) => {
    for (const r of (data[tab] || [])) {
      if (asInt(r[idAttr]) === uid) {
        const rowId = asInt(r.id);
        tasks.push(() => deleteRow(tab, rowId));
      }
    }
  };
  queue("occupancies", "unit_id");
  queue("bill_units", "unit_id");
  queue("recurring_bill_units", "unit_id");
  queue("payments", "unit_id");
  for (const t of tasks) await t();
  await deleteRow("units", uid);
  invalidate();
}
