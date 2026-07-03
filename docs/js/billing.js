/**
 * Bill-splitting + recurring-bill generation.
 *
 * Splitting is **pro-rated against the full bill period**:
 *   • A unit's actual contribution = Σ over its occupancies of
 *     (tenant_count × inclusive overlap days with the bill period).
 *   • Each unit is charged at a fixed per-person-day rate =
 *     bill.amount / (full-occupancy person-days), where full-occupancy
 *     person-days = Σ over assigned units of (the unit's tenant_count ×
 *     the full bill-period length). So a tenant present for only half the
 *     period pays half; the vacant remainder is simply NOT billed (it is
 *     not redistributed to the other units).
 *   • When every assigned unit occupies the entire bill period, the
 *     reference equals the actual person-days, so the full amount is
 *     recovered and the split reduces to plain person-day proportions.
 *   • Per-unit amounts are rounded to 2 decimals.
 *   • A unit with no overlap owes $0 and is filtered out on the dashboard.
 */
import {
  addDays, lastDayOfMonth, overlapDays, parseDate, parseNamesCsv,
  parseRecurrenceConfig,
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

/** Inclusive length of the bill's period in days. */
function billPeriodDays(bill) {
  return Math.round((bill.end_date - bill.start_date) / 86400000) + 1;
}

/**
 * A unit's full-occupancy reference person-days for a bill: the tenant count
 * it would have (its peak headcount among occupancies overlapping the bill)
 * times the full bill-period length. This is the denominator basis so that
 * partial occupancy is pro-rated rather than absorbing the whole bill.
 */
function unitReferencePersonDays(occupancies, bill) {
  let repTenants = 0;
  for (const o of occupancies) {
    const start = o.start_date instanceof Date ? o.start_date : parseDate(o.start_date);
    const end = o.end_date instanceof Date ? o.end_date : parseDate(o.end_date);
    if (overlapDays(start, end, bill.start_date, bill.end_date) > 0) {
      repTenants = Math.max(repTenants, o.tenant_count || 0);
    }
  }
  return repTenants * billPeriodDays(bill);
}

/**
 * Split a bill across its assigned units, pro-rated against the full period.
 *   bill: { amount, start_date (Date), end_date (Date),
 *           assignments: [{ unit_id, unit: { id, name } }, …] }
 *   occMap: { unit_id → [occupancy, …] }
 * Returns [{ unit_id, unit_name, person_days, amount }, …]
 */
export function splitBill(bill, occMap) {
  const pdByUnit = new Map();
  const refByUnit = new Map();
  for (const a of bill.assignments) {
    const occs = occMap[a.unit_id] || [];
    pdByUnit.set(a.unit_id, unitPersonDays(occs, bill));
    refByUnit.set(a.unit_id, unitReferencePersonDays(occs, bill));
  }
  let referenceTotal = 0;
  for (const v of refByUnit.values()) referenceTotal += v;
  const shares = [];
  for (const a of bill.assignments) {
    const pd = pdByUnit.get(a.unit_id) || 0;
    const amount = referenceTotal > 0 ? (pd / referenceTotal) * bill.amount : 0;
    shares.push({
      unit_id: a.unit_id,
      unit_name: a.unit ? a.unit.name : "",
      person_days: pd,
      amount: Math.round(amount * 100) / 100,
    });
  }
  return shares;
}

/** Case-insensitive membership of `kind` in an occupancy's covered_kinds. */
export function coversKind(occupancy, kind) {
  const k = String(kind || "").trim().toLowerCase();
  if (!k) return false;
  const kinds = Array.isArray(occupancy.covered_kinds)
    ? occupancy.covered_kinds
    : parseNamesCsv(occupancy.covered_kinds);
  return kinds.some((c) => String(c).trim().toLowerCase() === k);
}

/**
 * Fraction of a unit's person-days on `bill` contributed by occupancies whose
 * covered_kinds include the bill's kind — i.e. how much of the unit's share
 * is auto-covered (counted as paid). 1 when every overlapping occupancy
 * covers the kind, 0 when none does.
 */
export function coveredFraction(occupancies, bill) {
  let total = 0, covered = 0;
  for (const o of occupancies) {
    const start = o.start_date instanceof Date ? o.start_date : parseDate(o.start_date);
    const end = o.end_date instanceof Date ? o.end_date : parseDate(o.end_date);
    const pd = overlapDays(start, end, bill.start_date, bill.end_date) * (o.tenant_count || 0);
    total += pd;
    if (coversKind(o, bill.kind)) covered += pd;
  }
  return total > 0 ? covered / total : 0;
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
  if (!start) return out; // unparseable start_date: nothing to generate

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
