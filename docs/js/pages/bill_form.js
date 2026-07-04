/**
 * Bill / credit new/edit form.
 *
 * Routes:
 *   #bills/new           → blank bill form
 *   #bills/new?credit=1  → blank credit form (stored as a negative amount)
 *   #bills/<id>/edit     → prefilled form + Delete in the save bar; credit
 *                          mode follows the sign of the stored amount
 */
import {
  appendRow, deleteRow, deleteRows, invalidate, nextId, readAll, updateRow,
} from "../sheets.js";
import {
  asFloat, asInt, asOptFloat, asOptInt, clear, datesValid, flash, formatDate,
  h, parseDate,
} from "../util.js";

export default async function mountBillForm(container, params, query) {
  // params[0] is either undefined (new) or the bill id string
  const isEdit = params.length && params[0] !== "new";
  const billId = isEdit ? parseInt(params[0], 10) : null;
  let isCredit = !isEdit && query && query.get("credit") === "1";

  clear(container);
  const heading = h("h1", null);
  container.appendChild(heading);

  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const categories = (data.categories || [])
    .map((r) => (r.name || "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const units = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let bill = null;
  let selectedUnitIds = new Set();
  const savedPercents = new Map(); // unit_id → split_percent (numbers only)
  if (isEdit) {
    const rawBill = (data.bills || []).find((r) => asInt(r.id) === billId);
    if (!rawBill) {
      container.appendChild(h("p", { class: "flash err" }, "Bill not found."));
      return;
    }
    bill = {
      id: asInt(rawBill.id),
      kind: rawBill.kind || "",
      amount: asFloat(rawBill.amount),
      start_date: parseDate(rawBill.start_date),
      end_date: parseDate(rawBill.end_date),
      note: rawBill.note || "",
      recurring_bill_id: asOptInt(rawBill.recurring_bill_id),
    };
    isCredit = bill.amount < 0;
    for (const r of (data.bill_units || [])) {
      if (asInt(r.bill_id) !== billId) continue;
      const uid = asInt(r.unit_id);
      selectedUnitIds.add(uid);
      const pct = asOptFloat(r.split_percent);
      if (pct !== null) savedPercents.set(uid, pct);
    }
  }

  const kindWord = isCredit ? "credit" : "bill";
  heading.textContent = `${isEdit ? "Edit" : "New"} ${kindWord}`;
  if (isCredit) {
    container.appendChild(h("p", { class: "muted" },
      "A credit is stored as a negative amount and reduces what the assigned " +
      "units owe (split across them by person-days, same as bills)."));
  }

  // --- Form ---
  const form = h("form", { id: "billform" });

  // Category
  const kindSelect = h("select", { name: "kind" });
  if (!categories.length) {
    kindSelect.appendChild(h("option", { disabled: true }, "No categories defined"));
  } else {
    for (const k of categories) {
      const opt = h("option", { value: k }, k);
      if (bill && bill.kind === k) opt.selected = true;
      kindSelect.appendChild(opt);
    }
  }
  form.appendChild(h("label", null, "Category", kindSelect));
  form.appendChild(h("p", { class: "muted" },
    h("a", { href: "#categories" }, "Manage categories")));

  // Amount
  const amountInput = h("input", {
    type: "number", step: "0.01", min: "0", name: "amount", required: true,
    value: bill ? String(Math.abs(bill.amount)) : "",
  });
  form.appendChild(h("label", null,
    isCredit ? "Credit amount ($)" : "Amount ($)", amountInput));

  // Start / end dates
  const startInput = h("input", {
    type: "date", name: "start_date", required: true,
    value: bill ? formatDate(bill.start_date) : "",
  });
  form.appendChild(h("label", null, "Bill period start", startInput));
  const endInput = h("input", {
    type: "date", name: "end_date", required: true,
    value: bill ? formatDate(bill.end_date) : "",
  });
  form.appendChild(h("label", null, "Bill period end (inclusive)", endInput));
  form.appendChild(h("p", { class: "muted" },
    "Due date is automatically the 1st of the month after the bill period ends."));

  // Note
  const noteInput = h("input", {
    name: "note", value: bill ? bill.note : "",
  });
  form.appendChild(h("label", null, "Note", noteInput));

  // Unit assignment checkboxes (with an optional fixed-% share per unit)
  const fs = h("fieldset", { style: { marginTop: "1rem" } },
    h("legend", null, "Assign to units"));
  const pctInputs = new Map(); // unit_id → % input element
  if (!units.length) {
    fs.appendChild(h("p", { class: "muted" },
      "No units defined. ",
      h("a", { href: "#units/manage" }, "Add one"),
      " first."));
  } else {
    fs.appendChild(h("p", { class: "muted", style: { marginTop: "0" } },
      "Optionally give a unit a fixed % of the " + kindWord + ". Units with " +
      "a % take that share (pro-rated if occupied for only part of the " +
      "period); whatever % is left is split across the other units by " +
      "headcount. Leave all blank for a pure headcount split."));
    for (const u of units) {
      const cb = h("input", {
        type: "checkbox", name: "unit_ids", value: String(u.id),
      });
      if (selectedUnitIds.has(u.id)) cb.checked = true;
      const pct = h("input", {
        type: "number", step: "0.01", min: "0", max: "100",
        placeholder: "headcount",
        style: { width: "6.5rem", marginLeft: "0.75rem" },
        value: savedPercents.has(u.id) ? String(savedPercents.get(u.id)) : "",
      });
      pctInputs.set(u.id, pct);
      fs.appendChild(h("label",
        { style: { display: "block" } }, cb, " ", u.name, " ", pct, " %"));
    }
  }
  form.appendChild(fs);

  container.appendChild(form);

  // --- Sticky save bar ---
  const saveBtn = h("button", {
    class: "btn", type: "submit", form: "billform",
  }, "Save");
  const saveBar = h("div", { class: "sticky-save" },
    saveBtn,
    h("a", { class: "btn-secondary", href: "#bills" }, "Cancel"),
  );

  if (isEdit) {
    saveBar.appendChild(h("form", {
      class: "inline danger",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!confirm(`Delete this ${kindWord}? This cannot be undone.`)) return;
        try {
          // Remove bill_units first to keep cascade clean.
          const buIds = (data.bill_units || [])
            .filter((r) => asInt(r.bill_id) === billId)
            .map((r) => asInt(r.id));
          await deleteRows("bill_units", buIds);
          await deleteRow("bills", billId);
          invalidate();
          flash(`${isCredit ? "Credit" : "Bill"} removed.`);
          window.location.hash = "#bills";
        } catch (err) {
          flash(`Delete failed: ${err.message}`, "err");
        }
      },
    }, h("button", { class: "btn-danger", type: "submit" }, `Delete ${kindWord}`)));
  }

  container.appendChild(saveBar);

  // --- Submit handler ---
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!datesValid([
      [startInput.value, "Bill period start"],
      [endInput.value, "Bill period end"],
    ])) return;
    const checkedUids = [...form.querySelectorAll("input[name='unit_ids']:checked")]
      .map((cb) => parseInt(cb.value, 10));
    // [unit_id, split_percent ("" = headcount)] with % inputs validated.
    const assignments = [];
    let pctSum = 0;
    for (const uid of checkedUids) {
      const raw = (pctInputs.get(uid)?.value || "").trim();
      let pct = "";
      if (raw !== "") {
        pct = parseFloat(raw);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
          flash("Unit % must be a number between 0 and 100.", "err");
          return;
        }
        pctSum += pct;
      }
      assignments.push([uid, pct]);
    }
    if (pctSum > 100) {
      flash(`Unit percentages add up to ${pctSum}% — they can't exceed 100%.`, "err");
      return;
    }
    saveBtn.disabled = true;
    try {
      const magnitude = Math.abs(parseFloat(amountInput.value));
      const payload = {
        kind: kindSelect.value,
        amount: isCredit ? -magnitude : magnitude,
        start_date: startInput.value,
        end_date: endInput.value,
        note: noteInput.value.trim(),
      };
      if (isEdit) {
        await updateRow("bills", billId, payload);
        // Reset bill_units assignments.
        const existing = (await readAll()).bill_units || [];
        const toDelete = existing
          .filter((r) => asInt(r.bill_id) === billId)
          .map((r) => asInt(r.id));
        await deleteRows("bill_units", toDelete);
        // Add fresh assignments. Refresh nextId after deletes.
        const freshBu = (await readAll()).bill_units || [];
        let nextBuId = nextId(freshBu);
        for (const [uid, pct] of assignments) {
          await appendRow("bill_units", {
            id: nextBuId, bill_id: billId, unit_id: uid, split_percent: pct,
          });
          nextBuId++;
        }
        invalidate();
        flash(`${isCredit ? "Credit" : "Bill"} updated.`);
      } else {
        const newId = nextId(data.bills || []);
        await appendRow("bills", { id: newId, ...payload, recurring_bill_id: "" });
        const freshBu = (await readAll()).bill_units || [];
        let nextBuId = nextId(freshBu);
        for (const [uid, pct] of assignments) {
          await appendRow("bill_units", {
            id: nextBuId, bill_id: newId, unit_id: uid, split_percent: pct,
          });
          nextBuId++;
        }
        invalidate();
        flash(`${isCredit ? "Credit" : "Bill"} added.`);
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
