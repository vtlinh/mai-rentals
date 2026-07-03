/**
 * Recurring bill / credit form.
 *
 * Routes:
 *   #recurring/new           → new recurring bill
 *   #recurring/new?credit=1  → new recurring credit
 *   #recurring/<id>/edit     → edit (mode follows the row's is_credit)
 *
 * A credit generates negative-amount bills. Toggling the credit flag on edit
 * re-signs already-generated bills so dashboard totals stay consistent.
 */
import {
  appendRow, deleteRow, invalidate, nextId, readAll, updateRow,
} from "../sheets.js";
import {
  asBool, asFloat, asInt, asOptInt, clear, csvFromList, datesValid, flash,
  formatDate, h, MONTH_NAMES, parseDate, parseRecurrenceConfig, WEEKDAY_NAMES,
} from "../util.js";

export default async function mountRecurringForm(container, params, query) {
  const isEdit = params.length && params[0] !== "new";
  const rid = isEdit ? parseInt(params[0], 10) : null;

  clear(container);
  const loading = h("p", { class: "muted" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const categories = (data.categories || [])
    .map((r) => (r.name || "").trim()).filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const units = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let rb = null;
  let selectedUnitIds = new Set();
  let isCredit = (query && query.get("credit") === "1");

  if (isEdit) {
    const raw = (data.recurring_bills || []).find((r) => asInt(r.id) === rid);
    if (!raw) {
      container.appendChild(h("p", { class: "flash err" }, "Recurring bill not found."));
      return;
    }
    rb = {
      id: asInt(raw.id), kind: raw.kind || "", amount: asFloat(raw.amount),
      note: raw.note || "", recurrence: raw.recurrence || "monthly",
      recurrence_config: parseRecurrenceConfig(raw.recurrence_config),
      start_date: parseDate(raw.start_date),
      end_date: raw.end_date ? parseDate(raw.end_date) : null,
      active: asBool(raw.active, true),
      is_credit: asBool(raw.is_credit, false),
      bill_timing: (raw.bill_timing || "end").trim() || "end",
    };
    isCredit = rb.is_credit;
    for (const r of (data.recurring_bill_units || [])) {
      if (asInt(r.recurring_bill_id) === rid) selectedUnitIds.add(asInt(r.unit_id));
    }
  }

  const label = isCredit ? "Credit" : "Bill";
  container.appendChild(h("h1", null, `${isEdit ? "Edit" : "New"} Recurring ${label}`));
  if (isCredit) {
    container.appendChild(h("p", { class: "muted" },
      "A recurring credit generates negative-amount bills that reduce what " +
      "assigned units owe (split across them by person-days, same as bills)."));
  }

  const form = h("form", { id: "recurringform" });

  // Category
  const kindSelect = h("select", { name: "kind" });
  for (const k of categories) {
    const opt = h("option", { value: k }, k);
    if (rb && rb.kind === k) opt.selected = true;
    kindSelect.appendChild(opt);
  }
  form.appendChild(h("label", null, "Category", kindSelect));

  // Amount
  const amountInput = h("input", {
    type: "number", step: "0.01", min: "0", name: "amount", required: true,
    value: rb ? String(rb.amount) : "",
  });
  form.appendChild(h("label", null, "Amount ($)", amountInput));

  // Note
  const noteInput = h("input", { name: "note", value: rb ? rb.note : "" });
  form.appendChild(h("label", null, "Note", noteInput));

  // Start / end dates
  const startInput = h("input", {
    type: "date", name: "start_date", required: true,
    value: rb ? formatDate(rb.start_date) : "",
  });
  form.appendChild(h("label", null, "Starts on", startInput));
  const endInput = h("input", {
    type: "date", name: "end_date",
    value: rb && rb.end_date ? formatDate(rb.end_date) : "",
  });
  form.appendChild(h("label", null,
    "Ends on ", h("span", { class: "muted" }, "(optional)"), endInput));
  form.appendChild(h("p", { class: "muted" },
    "Entries are generated from the start date forward up to today (and never " +
    "past the end date, if set) each time the Bills page is visited."));

  // ---- Bill timing ----
  const timingSelect = h("select", { name: "bill_timing" },
    h("option", { value: "end" }, "End of period — due the following month"),
    h("option", { value: "start" }, "Start of period — due within the period"),
  );
  timingSelect.value = (rb && rb.bill_timing === "start") ? "start" : "end";
  form.appendChild(h("label", null, "When to bill", timingSelect));
  form.appendChild(h("p", { class: "muted" },
    "“End” bills the period on the 1st of the following month (e.g. an " +
    "April period shows on May’s dashboard). “Start” bills it within the " +
    "period itself (an April period shows on April’s dashboard)."));

  // ---- Recurrence ----
  const recurrence = rb ? rb.recurrence : "monthly";
  const cfg = rb ? rb.recurrence_config : [];

  const fs = h("fieldset", { style: { marginTop: "1rem" } },
    h("legend", null, "Recurrence"));

  const recurrenceRow = h("div",
    { style: { display: "flex", gap: "1.5rem", marginBottom: "1rem", flexWrap: "wrap" } });
  const cfgSections = {};
  const radios = {};
  for (const r of ["daily", "weekly", "monthly", "yearly"]) {
    const radio = h("input", {
      type: "radio", name: "recurrence", value: r,
      onchange: () => _showConfig(cfgSections, r),
    });
    if (recurrence === r) radio.checked = true;
    radios[r] = radio;
    recurrenceRow.appendChild(h("label",
      { style: { display: "inline", margin: "0" } },
      radio, " ", r[0].toUpperCase() + r.slice(1)));
  }
  fs.appendChild(recurrenceRow);

  // Weekly config (weekday 0=Mon..6=Sun)
  cfgSections.weekly = _checkboxGrid(
    "config_weekly",
    WEEKDAY_NAMES.map((name, i) => ({ value: i, label: name.slice(0, 3) })),
    recurrence === "weekly" ? cfg : [],
    "Bill covers Mon–Sun of each week; triggered on the first selected weekday that passes.",
  );
  // Monthly config (day 1..31)
  cfgSections.monthly = _checkboxGrid(
    "config_monthly",
    Array.from({ length: 31 }, (_, i) => ({ value: i + 1, label: String(i + 1) })),
    recurrence === "monthly" ? cfg : [],
    "Bill covers the full month; triggered on the first selected day that passes.",
  );
  // Yearly config (month 1..12)
  cfgSections.yearly = _checkboxGrid(
    "config_yearly",
    MONTH_NAMES.map((name, i) => ({ value: i + 1, label: name.slice(0, 3) })),
    recurrence === "yearly" ? cfg : [],
    "One bill per selected month each year; each bill covers that full month.",
  );
  for (const key of ["weekly", "monthly", "yearly"]) fs.appendChild(cfgSections[key]);
  form.appendChild(fs);

  // ---- Unit assignment ----
  const unitFs = h("fieldset", { style: { marginTop: "1rem" } },
    h("legend", null, "Assign to units"));
  if (!units.length) {
    unitFs.appendChild(h("p", { class: "muted" },
      "No units defined. ", h("a", { href: "#units/manage" }, "Add one"), " first."));
  } else {
    for (const u of units) {
      const cb = h("input", { type: "checkbox", name: "unit_ids", value: String(u.id) });
      if (selectedUnitIds.has(u.id)) cb.checked = true;
      unitFs.appendChild(h("label", { style: { display: "block" } }, cb, " ", u.name));
    }
  }
  form.appendChild(unitFs);

  // Active
  const activeCb = h("input", { type: "checkbox", name: "active" });
  if (!rb || rb.active) activeCb.checked = true;
  form.appendChild(h("label", { style: { marginTop: "1rem" } },
    activeCb, " Active (generate entries automatically)"));

  container.appendChild(form);
  _showConfig(cfgSections, recurrence);

  // ---- Sticky save bar ----
  const saveBtn = h("button", { class: "btn", type: "submit", form: "recurringform" }, "Save");
  const saveBar = h("div", { class: "sticky-save" },
    saveBtn,
    h("a", { class: "btn-secondary", href: "#bills" }, "Cancel"),
  );
  if (isEdit) {
    saveBar.appendChild(h("form", {
      class: "inline danger",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!confirm(`Delete this recurring ${label.toLowerCase()} and all its ` +
                     `generated entries? This cannot be undone.`)) return;
        try {
          await _deleteRecurringCascade(rid, data);
          flash("Recurring bill removed.");
          window.location.hash = "#bills";
        } catch (err) {
          flash(`Delete failed: ${err.message}`, "err");
        }
      },
    }, h("button", { class: "btn-danger", type: "submit" },
      `Delete recurring ${label.toLowerCase()}`)));
  }
  container.appendChild(saveBar);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!datesValid([
      [startInput.value, "Start date"],
      [endInput.value, "End date", true],
    ])) return;
    saveBtn.disabled = true;
    try {
      const chosenRecurrence =
        form.querySelector("input[name='recurrence']:checked").value;
      const configList = _readConfig(form, chosenRecurrence);
      const checkedUids = [...form.querySelectorAll("input[name='unit_ids']:checked")]
        .map((cb) => parseInt(cb.value, 10));
      const amount = parseFloat(amountInput.value);
      const billTiming = timingSelect.value === "start" ? "start" : "end";
      const payload = {
        kind: kindSelect.value,
        amount,
        note: noteInput.value.trim(),
        recurrence: chosenRecurrence,
        recurrence_config: csvFromList(configList),
        start_date: startInput.value,
        end_date: endInput.value || "",
        active: activeCb.checked,
        is_credit: isCredit,
        bill_timing: billTiming,
      };

      if (isEdit) {
        await updateRow("recurring_bills", rid, payload);
        // Replace unit assignments.
        const fresh = await readAll();
        for (const r of (fresh.recurring_bill_units || [])) {
          if (asInt(r.recurring_bill_id) === rid) await deleteRow("recurring_bill_units", asInt(r.id));
        }
        const fresh2 = await readAll();
        let nextRbu = nextId(fresh2.recurring_bill_units || []);
        for (const uid of checkedUids) {
          await appendRow("recurring_bill_units",
            { id: nextRbu, recurring_bill_id: rid, unit_id: uid });
          nextRbu++;
        }
        // Re-sign generated bills if credit flag changed.
        if (isCredit !== rb.is_credit) {
          const signed = isCredit ? -Math.abs(amount) : Math.abs(amount);
          for (const b of (fresh2.bills || [])) {
            if (asOptInt(b.recurring_bill_id) === rid) {
              await updateRow("bills", asInt(b.id), { amount: signed });
            }
          }
        }
        // Re-stamp generated bills' due dates if the timing changed, so the
        // dashboard month they land in follows the new setting.
        if (billTiming !== rb.bill_timing) {
          for (const b of (fresh2.bills || [])) {
            if (asOptInt(b.recurring_bill_id) === rid) {
              const due = billTiming === "start" ? (b.start_date || "") : "";
              await updateRow("bills", asInt(b.id), { due_date: due });
            }
          }
        }
        invalidate();
        flash(`Recurring ${label.toLowerCase()} updated.`);
      } else {
        const newId = nextId(data.recurring_bills || []);
        await appendRow("recurring_bills", { id: newId, ...payload });
        const fresh = await readAll();
        let nextRbu = nextId(fresh.recurring_bill_units || []);
        for (const uid of checkedUids) {
          await appendRow("recurring_bill_units",
            { id: nextRbu, recurring_bill_id: newId, unit_id: uid });
          nextRbu++;
        }
        invalidate();
        flash(`Recurring ${isCredit ? "credit" : "bill"} added.`);
      }
      window.location.hash = "#bills";
    } catch (err) {
      console.error(err);
      flash(`Save failed: ${err.message}`, "err");
    } finally {
      saveBtn.disabled = false;
    }
  });
}

function _checkboxGrid(name, items, selected, helpText) {
  const wrap = h("div", { class: "cfg-section", style: { display: "none" } });
  wrap.appendChild(h("p", { class: "muted" }, helpText));
  const grid = h("div", { style: { display: "flex", gap: "0.4rem", flexWrap: "wrap" } });
  const sel = new Set(selected);
  for (const it of items) {
    const cb = h("input", { type: "checkbox", name, value: String(it.value) });
    if (sel.has(it.value)) cb.checked = true;
    grid.appendChild(h("label", {
      style: {
        display: "inline", margin: "0", padding: "0.2rem 0.5rem",
        border: "1px solid var(--border)", borderRadius: "4px",
      },
    }, cb, " ", it.label));
  }
  wrap.appendChild(grid);
  return wrap;
}

function _showConfig(sections, recurrence) {
  for (const key of ["weekly", "monthly", "yearly"]) {
    sections[key].style.display = (key === recurrence) ? "block" : "none";
  }
}

function _readConfig(form, recurrence) {
  if (recurrence === "daily") return [];
  const name = { weekly: "config_weekly", monthly: "config_monthly", yearly: "config_yearly" }[recurrence];
  if (!name) return [];
  return [...form.querySelectorAll(`input[name='${name}']:checked`)]
    .map((cb) => parseInt(cb.value, 10))
    .sort((a, b) => a - b);
}

async function _deleteRecurringCascade(rid, data) {
  const tasks = [];
  for (const b of (data.bills || [])) {
    if (asOptInt(b.recurring_bill_id) === rid) {
      const bid = asInt(b.id);
      // delete the bill's bill_units, then the bill
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
