/**
 * Small helpers shared across the static frontend.
 * Date math uses plain calendar dates (YYYY-MM-DD), never Date objects with
 * timezones — the app is timezone-agnostic and a "day" is always inclusive.
 */

// ---------------- Cell value coercion ----------------

export function asBool(v, dflt = false) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "string") {
    const x = v.trim().toLowerCase();
    if (["true", "yes", "1", "y", "t"].includes(x)) return true;
    if (["false", "no", "0", "n", "f", ""].includes(x)) return false;
  }
  return dflt;
}

export function asInt(v, dflt = 0) {
  if (v === null || v === undefined || v === "") return dflt;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : dflt;
}

export function asOptInt(v) {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

export function asFloat(v, dflt = 0) {
  if (v === null || v === undefined || v === "") return dflt;
  const n = parseFloat(String(v).trim());
  return Number.isFinite(n) ? n : dflt;
}

/** Parse recurrence_config from sheet CSV (e.g. "1,15") to [1, 15]. */
export function parseRecurrenceConfig(raw) {
  if (!raw) return [];
  return String(raw).split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => asInt(s))
    .filter((n) => Number.isFinite(n));
}

export function csvFromList(list) {
  if (!list || !list.length) return "";
  return list.map((x) => String(parseInt(x, 10))).join(",");
}

// ---------------- Plain-calendar dates ----------------

export function parseDate(s) {
  if (!s) return null;
  // Accept "YYYY-MM-DD" or a longer ISO string; we want a Date at midnight UTC
  // so day arithmetic is stable across timezones.
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const d = parseInt(m[3], 10);
  return new Date(Date.UTC(y, mo - 1, d));
}

export function formatDate(d) {
  if (!d) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function today() {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
}

export function addDays(d, n) {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + n);
  return out;
}

/** Inclusive overlap days between [a1, a2] and [b1, b2]. 0 if disjoint. */
export function overlapDays(a1, a2, b1, b2) {
  const start = a1 > b1 ? a1 : b1;
  const end = a2 < b2 ? a2 : b2;
  if (start > end) return 0;
  return Math.round((end - start) / 86400000) + 1;
}

/** First of the month after `endDate` — the default "bill at end" due date. */
export function billDueDate(endDate) {
  const y = endDate.getUTCFullYear();
  const m = endDate.getUTCMonth(); // 0-based
  if (m === 11) return new Date(Date.UTC(y + 1, 0, 1));
  return new Date(Date.UTC(y, m + 1, 1));
}

/**
 * The due date a bill is grouped under on the dashboard. If the bill carries an
 * explicit `due_date` (recurring templates that bill at the start of the period
 * stamp this, and it can be hand-set in the sheet), use it; otherwise derive the
 * default "1st of the month after the period ends".
 */
export function effectiveDueDate(bill) {
  const raw = bill.due_date;
  if (raw) {
    const d = raw instanceof Date ? raw : parseDate(raw);
    if (d) return d;
  }
  return billDueDate(bill.end_date);
}

/** Last day of (year, month) — month is 1-based here. */
export function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// ---------------- Formatting ----------------

export function fmtMoney(n) {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

export const WEEKDAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// ---------------- DOM helpers ----------------

/** Create an element with attrs and children (string or Node). */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "html") {
        el.innerHTML = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Render the user-facing flash strip at the top of #app. */
let _flashTimeoutId = null;
export function flash(message, kind = "ok") {
  const root = document.getElementById("flash-area");
  if (!root) return;
  clear(root);
  root.appendChild(h("div", { class: `flash ${kind}` }, message));
  if (_flashTimeoutId) clearTimeout(_flashTimeoutId);
  _flashTimeoutId = setTimeout(() => clear(root), 5000);
}
