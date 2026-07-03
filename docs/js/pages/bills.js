/**
 * Bills page: recurring section (table of templates) on top, one-off bills
 * below. The recurring section here is read-only summary; the dedicated
 * recurring-bill form (Phase 4) handles add/edit. One-off bills have an
 * "edit" link per row; delete moves to inside the bill edit form (matching
 * the Flask app's pattern).
 */
import { invalidate, readAll, updateRow } from "../sheets.js";
import { deleteRecurringCascade } from "../cascade.js";
import {
  asBool, asFloat, asInt, asOptInt, clear, effectiveDueDate, flash, fmtMoney, h,
  MONTH_NAMES, parseDate, parseRecurrenceConfig, WEEKDAY_NAMES,
} from "../util.js";

export default async function mountBills(container) {
  clear(container);
  container.appendChild(h("h1", null, "Bills"));

  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  _renderRecurring(container, data);
  _renderOneOff(container, data);
}

function _renderRecurring(container, data) {
  container.appendChild(h("h2", null, "Recurring bills & credits"));
  container.appendChild(h("p", { class: "actions" },
    h("a", { class: "btn", href: "#recurring/new" }, "+ Add recurring bill"),
    h("a", { class: "btn", href: "#recurring/new?credit=1" }, "+ Add recurring credit"),
    h("a", { class: "btn-secondary", href: "#categories" }, "Manage categories"),
  ));

  const rbs = (data.recurring_bills || []).map(_parseRecurring);
  // Map each rb to its assigned unit names
  const units = new Map(
    (data.units || []).map((r) => [asInt(r.id), r.name || ""]),
  );
  const unitsByRb = new Map();
  for (const r of (data.recurring_bill_units || [])) {
    const rid = asInt(r.recurring_bill_id);
    const uid = asInt(r.unit_id);
    if (!unitsByRb.has(rid)) unitsByRb.set(rid, []);
    unitsByRb.get(rid).push(units.get(uid) || `unit ${uid}`);
  }
  // Generated bill counts
  const generated = new Map();
  for (const r of (data.bills || [])) {
    const rid = asOptInt(r.recurring_bill_id);
    if (rid !== null) generated.set(rid, (generated.get(rid) || 0) + 1);
  }

  const tbl = h("table");
  tbl.appendChild(h("tr", null,
    h("th", null, "Type"),
    h("th", null, "Category"),
    h("th", { class: "right" }, "Amount"),
    h("th", null, "Schedule"),
    h("th", null, "Units"),
    h("th", null, "Status"),
    h("th", null, "Generated"),
    h("th", null, ""),
  ));
  rbs.sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);
  for (const rb of rbs) {
    const cfgDisplay = _configDisplay(rb.recurrence,
      parseRecurrenceConfig(rb.recurrence_config));
    const scheduleCell = h("td", null, cfgDisplay);
    if (rb.end_date) {
      scheduleCell.appendChild(h("span", { class: "muted" },
        ` until ${rb.end_date.toISOString().slice(0, 10)}`));
    }
    if (rb.bill_timing === "start") {
      scheduleCell.appendChild(h("span", { class: "muted" }, " · billed at start"));
    }
    const kindWord = rb.is_credit ? "credit" : "bill";
    const actions = h("span", { class: "actions" },
      h("a", { class: "btn-secondary btn-sm", href: `#recurring/${rb.id}/edit` }, "edit"),
      h("button", {
        class: "btn-secondary btn-sm", type: "button",
        onclick: async () => {
          try {
            await updateRow("recurring_bills", rb.id, { active: !rb.active });
            invalidate("recurring_bills");
            flash(`Recurring ${kindWord} ${rb.active ? "paused" : "activated"}.`);
            await mountBills(container);
          } catch (e) { flash(`Failed: ${e.message}`, "err"); }
        },
      }, rb.active ? "pause" : "resume"),
      h("button", {
        class: "btn-danger btn-sm", type: "button",
        onclick: async () => {
          if (!confirm(`Delete this recurring ${kindWord} and all its generated ` +
                       `entries? This cannot be undone.`)) return;
          try {
            await deleteRecurringCascade(rb.id, data);
            flash(`Recurring ${kindWord} removed.`);
            await mountBills(container);
          } catch (e) { flash(`Delete failed: ${e.message}`, "err"); }
        },
      }, "delete"),
    );
    tbl.appendChild(h("tr", null,
      h("td", null, rb.is_credit
        ? h("span", { style: { color: "var(--accent-green)" } }, "credit")
        : "bill"),
      h("td", null, rb.kind),
      h("td", { class: "right" },
        (rb.is_credit ? "-" : "") + fmtMoney(rb.amount).replace("-", "")),
      scheduleCell,
      h("td", null, (unitsByRb.get(rb.id) || []).sort().join(", ") || "—"),
      h("td", null, rb.active
        ? h("span", { style: { color: "var(--accent-green)" } }, "active")
        : h("span", { class: "muted" }, "paused")),
      h("td", null, String(generated.get(rb.id) || 0)),
      h("td", null, actions),
    ));
  }
  if (!rbs.length) {
    tbl.appendChild(h("tr", null,
      h("td", { class: "muted", colspan: "8" },
        "No recurring bills or credits yet."),
    ));
  }
  container.appendChild(tbl);
}

function _renderOneOff(container, data) {
  container.appendChild(h("h2", null, "One-off bills & credits"));
  container.appendChild(h("p", { class: "actions" },
    h("a", { class: "btn", href: "#bills/new" }, "+ Add bill"),
    h("a", { class: "btn", href: "#bills/new?credit=1" }, "+ Add credit"),
  ));

  const bills = (data.bills || [])
    .map(_parseBill)
    .filter((b) => b.recurring_bill_id === null);

  const units = new Map(
    (data.units || []).map((r) => [asInt(r.id), r.name || ""]),
  );
  const assignsByBill = new Map();
  for (const r of (data.bill_units || [])) {
    const bid = asInt(r.bill_id);
    const uid = asInt(r.unit_id);
    if (!assignsByBill.has(bid)) assignsByBill.set(bid, []);
    assignsByBill.get(bid).push(units.get(uid) || `unit ${uid}`);
  }

  const tbl = h("table");
  tbl.appendChild(h("tr", null,
    h("th", null, "Category"),
    h("th", null, "Period (end inclusive)"),
    h("th", null, "Due"),
    h("th", { class: "right" }, "Amount"),
    h("th", null, "Units"),
    h("th", null, ""),
  ));

  const iso = (d) => (d ? d.toISOString().slice(0, 10) : "—");
  bills.sort((a, b) => (b.end_date?.getTime() || 0) - (a.end_date?.getTime() || 0));
  for (const b of bills) {
    const due = iso(effectiveDueDate(b));
    tbl.appendChild(h("tr", null,
      h("td", null, b.kind),
      h("td", null, `${iso(b.start_date)} → ${iso(b.end_date)}`),
      h("td", null, due),
      h("td", { class: "right" }, b.amount < 0
        ? h("span", { style: { color: "var(--accent-green)" } }, fmtMoney(b.amount))
        : fmtMoney(b.amount)),
      h("td", null, (assignsByBill.get(b.id) || []).sort().join(", ")),
      h("td", null,
        h("a", {
          class: "btn-secondary btn-sm",
          href: `#bills/${b.id}/edit`,
        }, "edit")),
    ));
  }
  if (!bills.length) {
    tbl.appendChild(h("tr", null,
      h("td", { class: "muted", colspan: "6" }, "No one-off bills or credits yet."),
    ));
  }
  container.appendChild(tbl);
}

function _parseRecurring(r) {
  return {
    id: asInt(r.id),
    kind: r.kind || "",
    amount: asFloat(r.amount),
    note: r.note || "",
    recurrence: r.recurrence || "monthly",
    recurrence_config: r.recurrence_config || "",
    start_date: parseDate(r.start_date),
    end_date: r.end_date ? parseDate(r.end_date) : null,
    active: asBool(r.active, true),
    is_credit: asBool(r.is_credit, false),
    bill_timing: (r.bill_timing || "end").trim() || "end",
  };
}

function _parseBill(r) {
  return {
    id: asInt(r.id),
    kind: r.kind || "",
    amount: asFloat(r.amount),
    start_date: parseDate(r.start_date),
    end_date: parseDate(r.end_date),
    note: r.note || "",
    recurring_bill_id: asOptInt(r.recurring_bill_id),
    due_date: r.due_date || "",
  };
}

function _configDisplay(recurrence, config) {
  if (recurrence === "daily") return "every day";
  if (recurrence === "weekly") {
    const days = config.filter((i) => i >= 0 && i <= 6).map((i) => WEEKDAY_NAMES[i]);
    return "every " + (days.join(", ") || "week");
  }
  if (recurrence === "monthly") {
    const ord = (n) => {
      const suff = (n >= 20 || n < 4) ? ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th") : "th";
      return `${n}${suff}`;
    };
    const days = config.filter((d) => d >= 1 && d <= 31).map(ord);
    return "monthly on the " + (days.join(", ") || "1st");
  }
  if (recurrence === "yearly") {
    const months = config.filter((m) => m >= 1 && m <= 12).map((m) => MONTH_NAMES[m - 1]);
    return "yearly in " + (months.join(", ") || "January");
  }
  return recurrence;
}
