/**
 * Google Sheets REST client. All operations require a signed-in user; a 403
 * from the API means the user isn't on the sheet's share list — that's the
 * privacy boundary.
 *
 * Reads are TTL-cached for ~10s so a single page render is one batchGet
 * across all tabs. Writes invalidate the affected tab so the next read picks
 * up the change.
 *
 * Storage convention (kept human-readable in the sheet):
 *   • dates as YYYY-MM-DD
 *   • booleans as TRUE / FALSE
 *   • recurrence_config as CSV like "1,15" (NOT JSON)
 *   • empty cell = NULL
 */
import { getAccessToken } from "./auth.js";
import { SHEET_ID, TABS } from "./config.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const CACHE_TTL_MS = 10_000;

const _cache = new Map();      // tab → { rows, ts }
const _sheetGids = new Map();  // tab → integer sheet gid (needed for row deletes)
let _gidsLoaded = false;

// ---------------- Low-level fetch ----------------

async function _fetch(path, opts = {}) {
  const token = getAccessToken();
  if (!token) throw new AuthError("not signed in");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  const r = await fetch(`${API}/${SHEET_ID}${path}`, { ...opts, headers });
  if (r.status === 401) throw new AuthError("token expired");
  if (r.status === 403) {
    const body = await r.text().catch(() => "");
    throw new ForbiddenError(
      body.includes("does not have permission")
        ? "Your Google account isn't on this sheet's share list."
        : "Sheets API returned 403."
    );
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Sheets API ${r.status}: ${txt}`);
  }
  return r.json();
}

export class AuthError extends Error {}
export class ForbiddenError extends Error {}

// ---------------- Sheet ID resolution ----------------

async function _loadGids() {
  if (_gidsLoaded) return;
  const meta = await _fetch("?fields=sheets(properties(sheetId,title))");
  for (const sh of meta.sheets || []) {
    _sheetGids.set(sh.properties.title, sh.properties.sheetId);
  }
  _gidsLoaded = true;
}

// ---------------- Reads ----------------

/**
 * Batch-read every known tab in one API call, caching for CACHE_TTL_MS.
 * Used by readAll() and as the underlying call for readTab().
 */
async function _batchRead(tabs) {
  const ranges = tabs.map((t) => encodeURIComponent(t)).map((t) => `ranges=${t}`).join("&");
  const data = await _fetch(`/values:batchGet?${ranges}`);
  const out = {};
  for (let i = 0; i < tabs.length; i++) {
    const values = (data.valueRanges?.[i]?.values) || [];
    out[tabs[i]] = _rowsFromValues(values, TABS[tabs[i]] || []);
  }
  return out;
}

function _rowsFromValues(values, expectedHeaders) {
  if (!values.length) return [];
  const headers = values[0].map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i] || [];
    if (!raw.some((c) => String(c).trim())) continue; // skip blank rows
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      if (!headers[j]) continue;
      row[headers[j]] = j < raw.length ? String(raw[j]).trim() : "";
    }
    rows.push(row);
  }
  return rows;
}

/** Read a single tab, with cache. */
export async function readTab(tab) {
  const hit = _cache.get(tab);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return hit.rows.map((r) => ({ ...r }));
  }
  const data = await _batchRead([tab]);
  _cache.set(tab, { rows: data[tab], ts: Date.now() });
  return data[tab].map((r) => ({ ...r }));
}

/** Read every tab in one API call. Returns { tab: rows[] }. */
export async function readAll() {
  const allTabs = Object.keys(TABS);
  const now = Date.now();
  const stale = allTabs.filter((t) => {
    const hit = _cache.get(t);
    return !hit || now - hit.ts >= CACHE_TTL_MS;
  });
  if (stale.length) {
    const fresh = await _batchRead(stale);
    for (const t of stale) {
      _cache.set(t, { rows: fresh[t], ts: now });
    }
  }
  const out = {};
  for (const t of allTabs) out[t] = _cache.get(t).rows.map((r) => ({ ...r }));
  return out;
}

export function invalidate(tab) {
  if (tab === undefined) _cache.clear();
  else _cache.delete(tab);
}

// ---------------- Writes ----------------

/** Append a row. `row` is a {column: value} map. Missing columns become "". */
export async function appendRow(tab, row) {
  const cols = TABS[tab];
  if (!cols) throw new Error(`unknown tab: ${tab}`);
  const values = [cols.map((c) => _toCell(row[c]))];
  const path = `/values/${encodeURIComponent(tab)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  await _fetch(path, { method: "POST", body: JSON.stringify({ values }) });
  invalidate(tab);
}

/** Update an existing row by ID. `fields` is a {column: newValue} map. */
export async function updateRow(tab, id, fields) {
  const cols = TABS[tab];
  if (!cols) throw new Error(`unknown tab: ${tab}`);
  // Find the 1-based row index in the sheet (header is row 1).
  const rows = await readTab(tab);
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { idx = i; break; }
  }
  if (idx === -1) return;
  const sheetRow = idx + 2; // +1 for header, +1 for 1-based
  const merged = { ...rows[idx], ...fields };
  const values = [cols.map((c) => _toCell(merged[c]))];
  const lastCol = _columnLetter(cols.length);
  const path = `/values/${encodeURIComponent(tab)}!A${sheetRow}:${lastCol}${sheetRow}` +
               `?valueInputOption=USER_ENTERED`;
  await _fetch(path, { method: "PUT", body: JSON.stringify({ values }) });
  invalidate(tab);
}

/**
 * Update many rows of one tab in a single values:batchUpdate. `updates` is an
 * array of [id, fields] pairs. Row indices are resolved from one read, so this
 * shares deleteRow/updateRow's limitation: indices assume the sheet has no
 * interior blank rows (the reader skips them).
 */
export async function updateRows(tab, updates) {
  if (!updates || !updates.length) return;
  const cols = TABS[tab];
  if (!cols) throw new Error(`unknown tab: ${tab}`);
  const rows = await readTab(tab);
  const idxById = new Map(rows.map((r, i) => [String(r.id), i]));
  const lastCol = _columnLetter(cols.length);
  const data = [];
  for (const [id, fields] of updates) {
    const idx = idxById.get(String(id));
    if (idx === undefined) continue;
    const sheetRow = idx + 2; // +1 for header, +1 for 1-based
    const merged = { ...rows[idx], ...fields };
    data.push({
      range: `${tab}!A${sheetRow}:${lastCol}${sheetRow}`,
      values: [cols.map((c) => _toCell(merged[c]))],
    });
  }
  if (!data.length) return;
  await _fetch(`/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
  invalidate(tab);
}

/** Delete a row by ID. Uses batchUpdate (requires sheet gid). */
export async function deleteRow(tab, id) {
  await _loadGids();
  const gid = _sheetGids.get(tab);
  if (gid === undefined) return;
  const rows = await readTab(tab);
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i].id) === String(id)) { idx = i; break; }
  }
  if (idx === -1) return;
  const sheetRow = idx + 1; // 0-based, header is row 0
  await _fetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        deleteDimension: {
          range: {
            sheetId: gid,
            dimension: "ROWS",
            startIndex: sheetRow,
            endIndex: sheetRow + 1,
          },
        },
      }],
    }),
  });
  invalidate(tab);
}

/**
 * Delete many rows of one tab in a single batchUpdate. Row indices are
 * resolved from one read and the deleteDimension requests are sorted
 * descending, so earlier deletes in the batch can't shift later ones; the
 * batch is atomic (a failure deletes nothing). Shares deleteRow/updateRow's
 * limitation: indices assume the sheet has no interior blank rows (the
 * reader skips them).
 */
export async function deleteRows(tab, ids) {
  if (!ids || !ids.length) return;
  await _loadGids();
  const gid = _sheetGids.get(tab);
  if (gid === undefined) return;
  const rows = await readTab(tab);
  const want = new Set(ids.map((id) => String(id)));
  const indices = [];
  for (let i = 0; i < rows.length; i++) {
    if (want.has(String(rows[i].id))) indices.push(i + 1); // 0-based, header is row 0
  }
  if (!indices.length) return;
  indices.sort((a, b) => b - a);
  await _fetch(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      requests: indices.map((s) => ({
        deleteDimension: {
          range: {
            sheetId: gid,
            dimension: "ROWS",
            startIndex: s,
            endIndex: s + 1,
          },
        },
      })),
    }),
  });
  invalidate(tab);
}

// ---------------- Setup ----------------

/**
 * First-time setup: create every tab in TABS if missing, and ensure each has
 * the right header row. Safe to call repeatedly. Returns a summary string.
 */
export async function ensureTabs() {
  const meta = await _fetch("?fields=sheets(properties(sheetId,title))");
  const existing = new Set((meta.sheets || []).map((s) => s.properties.title));
  const requests = [];
  for (const [tab, _cols] of Object.entries(TABS)) {
    if (!existing.has(tab)) {
      requests.push({ addSheet: { properties: { title: tab } } });
    }
  }
  if (requests.length) {
    await _fetch(":batchUpdate", {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
  }
  // Now write/refresh header rows.
  const headerWrites = [];
  for (const [tab, cols] of Object.entries(TABS)) {
    headerWrites.push({
      range: `${tab}!A1`,
      values: [cols],
    });
  }
  await _fetch(`/values:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: headerWrites,
    }),
  });
  _gidsLoaded = false; // force reload
  invalidate();
  return `ensured ${Object.keys(TABS).length} tabs`;
}

// ---------------- Helpers ----------------

function _toCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

function _columnLetter(n) {
  // 1 → A, 26 → Z, 27 → AA
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Next integer ID = max(existing) + 1 (1 if empty). */
export function nextId(rows) {
  let best = 0;
  for (const r of rows) {
    const n = parseInt(r.id, 10);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best + 1;
}
