/**
 * Per-unit occupancy management.
 *
 * URL: #units/<id>/edit
 *
 * Each occupancy is its own little inline form with Save + delete. A separate
 * "Add occupancy" form at the bottom. The "Delete unit" danger section
 * cascades through occupancies, bill_units, recurring_bill_units, and
 * payments.
 */
import {
  appendRow, deleteRow, invalidate, nextId, readAll, updateRow,
} from "../sheets.js";
import { deleteUnitCascade } from "../cascade.js";
import {
  asInt, clear, datesValid, flash, formatDate, h, parseDate,
} from "../util.js";

export default async function mountManageOccupancy(container, params) {
  const uid = parseInt(params[0], 10);
  clear(container);

  const loading = h("p", { class: "muted" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const unit = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "" }))
    .find((u) => u.id === uid);
  if (!unit) {
    container.appendChild(h("h1", null, "Unit not found"));
    container.appendChild(h("p", null,
      h("a", { class: "btn-secondary", href: "#units" }, "← Back to units")));
    return;
  }

  container.appendChild(h("h1", null, `Manage occupancy — ${unit.name}`));
  container.appendChild(h("p", null,
    h("a", { class: "btn-secondary btn-sm", href: "#units" }, "← Back to units")));
  container.appendChild(h("p", { class: "muted" },
    "Each occupancy is a tenant headcount over an inclusive date range. " +
    "Bills are split across units by person-days (tenants × overlapping days)."));

  const occs = (data.occupancies || [])
    .filter((r) => asInt(r.unit_id) === uid)
    .map((r) => ({
      id: asInt(r.id),
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date),
      end_date: parseDate(r.end_date),
    }))
    .sort((a, b) => a.start_date - b.start_date);

  const list = h("div");
  if (occs.length) {
    for (const o of occs) list.appendChild(_existingOcc(container, uid, o));
  } else {
    list.appendChild(h("p", { class: "muted" }, "No occupancies yet."));
  }
  container.appendChild(list);

  // Add occupancy
  container.appendChild(h("h3", null, "Add occupancy"));
  container.appendChild(_addOccupancyForm(container, uid));

  // Delete unit danger section
  container.appendChild(h("hr", { style: { marginTop: "2rem" } }));
  container.appendChild(h("h3", null, "Delete unit"));
  container.appendChild(h("p", { class: "muted" },
    "Removes this unit and all of its occupancies, bill assignments, and " +
    "payments. This cannot be undone."));
  container.appendChild(h("form", { class: "inline" },
    h("button", {
      type: "button", class: "btn-danger",
      onclick: async () => {
        if (!confirm(`Delete unit ${unit.name} and all its data? This cannot be undone.`)) return;
        try {
          await deleteUnitCascade(uid, data);
          flash(`Unit '${unit.name}' removed.`);
          window.location.hash = "#units";
        } catch (e) {
          flash(`Delete failed: ${e.message}`, "err");
        }
      },
    }, "Delete unit"),
  ));
}

function _existingOcc(container, uid, o) {
  const row = h("div", {
    class: "card",
    style: {
      display: "flex", gap: "0.5rem", alignItems: "flex-end",
      flexWrap: "wrap", padding: "0.5rem",
    },
  });
  const tenantsInput = h("input", {
    type: "number", min: "1", required: true,
    value: String(o.tenant_count),
    style: { minWidth: "auto", width: "70px" },
  });
  const startInput = h("input", {
    type: "date", required: true,
    value: formatDate(o.start_date),
    style: { minWidth: "auto" },
  });
  const endInput = h("input", {
    type: "date", required: true,
    value: formatDate(o.end_date),
    style: { minWidth: "auto" },
  });

  const save = h("button", {
    class: "btn btn-sm", type: "button",
    onclick: async () => {
      if (!datesValid([
        [startInput.value, "Start date"],
        [endInput.value, "End date"],
      ])) return;
      save.disabled = true;
      try {
        await updateRow("occupancies", o.id, {
          tenant_count: parseInt(tenantsInput.value, 10),
          start_date: startInput.value,
          end_date: endInput.value,
        });
        invalidate("occupancies");
        flash("Occupancy updated.");
      } catch (e) {
        flash(`Save failed: ${e.message}`, "err");
      } finally {
        save.disabled = false;
      }
    },
  }, "Save");

  const del = h("button", {
    class: "btn-danger btn-sm", type: "button",
    onclick: async () => {
      if (!confirm("Delete this occupancy?")) return;
      try {
        await deleteRow("occupancies", o.id);
        invalidate("occupancies");
        row.remove();
        flash("Occupancy removed.");
      } catch (e) {
        flash(`Delete failed: ${e.message}`, "err");
      }
    },
  }, "delete");

  row.appendChild(_field("Tenants", tenantsInput));
  row.appendChild(_field("Start", startInput));
  row.appendChild(_field("End (inclusive)", endInput));
  row.appendChild(save);
  row.appendChild(del);
  return row;
}

function _addOccupancyForm(container, uid) {
  const tenantsInput = h("input", {
    type: "number", min: "1", required: true, value: "1",
    style: { minWidth: "auto", width: "70px" },
  });
  const startInput = h("input", {
    type: "date", required: true, style: { minWidth: "auto" },
  });
  const endInput = h("input", {
    type: "date", required: true, style: { minWidth: "auto" },
  });
  const form = h("form", {
    style: {
      display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap",
    },
    onsubmit: async (e) => {
      e.preventDefault();
      if (!datesValid([
        [startInput.value, "Start date"],
        [endInput.value, "End date"],
      ])) return;
      try {
        const data = await readAll();
        const newId = nextId(data.occupancies || []);
        await appendRow("occupancies", {
          id: newId, unit_id: uid,
          tenant_count: parseInt(tenantsInput.value, 10),
          start_date: startInput.value,
          end_date: endInput.value,
        });
        invalidate("occupancies");
        flash("Occupancy added.");
        await mountManageOccupancy(container, [String(uid)]);
      } catch (err) {
        flash(`Add failed: ${err.message}`, "err");
      }
    },
  });
  form.appendChild(_field("Tenants", tenantsInput));
  form.appendChild(_field("Start", startInput));
  form.appendChild(_field("End (inclusive)", endInput));
  form.appendChild(h("button", { class: "btn", type: "submit" }, "Add"));
  return form;
}

function _field(label, input) {
  return h("label",
    { style: { display: "inline-block", margin: "0" } },
    label, h("br"), input,
  );
}
