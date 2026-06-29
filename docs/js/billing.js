/**
 * Bill-splitting + recurring-bill generation. Port of app/billing.py.
 *
 * Invariants (also pinned in tests/test_billing.py on the Python side):
 *   • A unit's contribution to a bill = sum over the unit's occupancies of
 *     (tenant_count × inclusive overlap days with the bill period).
 *   • Bill amount is split across assigned units proportionally to their
 *     person-days; total person-days is the denominator (NOT the bill's
 *     full date range).
 *   • Per-unit amounts are rounded to 2 decimals; sum reconciles to the bill
 *     amount up to rounding.
 *   • A unit with no overlap owes $0 and is filtered out on the dashboard.
 */
import {
  addDays, lastDayOfMonth, overlapDays, parseDate, parseRecurrenceConfig,
} from "./util.js";

export function unitPersonDays(occupancies, bill) {
  let total = 0;
  for (const o of occupancies) {
    const start = o.start_date instanceof Date ? o.start_date : parseDate(o.start_date);
    const end = o.end_date instanceof Date ? o.end_date : parseDate(o.end_date);
    const days = overlapDays(start, end, bill.start_date, bill.end_date);
    total += days * (o.tenant_count || 0);
  }
  return total;
}

/**
 * Split a bill across its assigned units.
 *   bill: { amount, start_date (Date), end_date (Date),
 *           assignments: [{ unit_id, unit: { id, name } }, …] }
 *   occMap: { unit_id → [occupancy, …] }
 * Returns [{ unit_id, unit_name, person_days, amount }, …]
 */
export function splitBill(bill, occMap) {
  const pdByUnit = new Map();
  for (const a of bill.assignments) {
    const occs = occMap[a.unit_id] || [];
    pdByUnit.set(a.unit_id, unitPersonDays(occs, bill));
  }
  let total = 0;
  for (const v of pdByUnit.values()) total += v;
  const shares = [];
  for (const a of bill.assignments) {
    const pd = pdByUnit.get(a.unit_id) || 0;
    const amount = total > 0 ? (pd / total) * bill.amount : 0;
    shares.push({
      unit_id: a.unit_id,
      unit_name: a.unit ? a.unit.name : "",
      person_days: pd,
      amount: Math.round(amount * 100) / 100,
    });
  }
  return shares;
}

// ---------------- Recurring-bill generation ----------------

/**
 * Walk every period that should be generated for `rb` up to `today` (inclusive)
 * and return [(periodStart, periodEnd), …]. Returns periods that have not yet
 * passed; the caller is responsible for deduplicating against bills already
 * created (keyed by start_date).
 *
 * Deduplication anchor per recurrence:
 *   • daily  → single day
 *   • weekly → Mon–Sun period containing the trigger weekday
 *   • monthly → full calendar month
 *   • yearly  → full calendar month of each selected month
 */
export function recurringInstances(rb, today) {
  const start = rb.start_date instanceof Date ? rb.start_date : parseDate(rb.start_date);
  const config = Array.isArray(rb.recurrence_config)
    ? rb.recurrence_config
    : parseRecurrenceConfig(rb.recurrence_config);
  const endCap = rb.end_date
    ? (rb.end_date instanceof Date ? rb.end_date : parseDate(rb.end_date))
    : null;
  let cap = today;
  if (endCap && endCap < cap) cap = endCap;
  const out = [];

  if (rb.recurrence === "daily") {
    let d = start;
    while (d <= cap) {
      out.push([d, d]);
      d = addDays(d, 1);
    }
    return out;
  }

  if (rb.recurrence === "weekly") {
    // weekday indices [0=Mon..6=Sun]; default Monday
    const active = config.length ? [...config].sort((a, b) => a - b) : [0];
    // Anchor at the Monday of `start`. JS getUTCDay(): Sun=0..Sat=6 → convert to Mon=0..Sun=6.
    const startMonOffset = (start.getUTCDay() + 6) % 7;
    let monday = addDays(start, -startMonOffset);
    while (monday <= cap) {
      const sunday = addDays(monday, 6);
      for (const wd of active) {
        const trigger = addDays(monday, wd);
        if (trigger >= start && trigger <= cap) {
          out.push([monday, sunday]);
          break;
        }
      }
      monday = addDays(monday, 7);
    }
    return out;
  }

  if (rb.recurrence === "monthly") {
    const active = config.length ? [...config].sort((a, b) => a - b) : [1];
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth() + 1; // 1-based
    while (y < cap.getUTCFullYear() ||
           (y === cap.getUTCFullYear() && m <= cap.getUTCMonth() + 1)) {
      const last = lastDayOfMonth(y, m);
      for (const day of active) {
        const triggerDay = Math.min(day, last);
        const trigger = new Date(Date.UTC(y, m - 1, triggerDay));
        if (trigger >= start && trigger <= cap) {
          out.push([
            new Date(Date.UTC(y, m - 1, 1)),
            new Date(Date.UTC(y, m - 1, last)),
          ]);
          break;
        }
      }
      m += 1;
      if (m > 12) { y += 1; m = 1; }
    }
    return out;
  }

  if (rb.recurrence === "yearly") {
    const active = config.length ? [...config].sort((a, b) => a - b) : [1];
    for (let y = start.getUTCFullYear(); y <= cap.getUTCFullYear(); y++) {
      for (const month of active) {
        const billStart = new Date(Date.UTC(y, month - 1, 1));
        if (billStart >= start && billStart <= cap) {
          out.push([
            billStart,
            new Date(Date.UTC(y, month - 1, lastDayOfMonth(y, month))),
          ]);
        }
      }
    }
    return out;
  }

  return out;
}
