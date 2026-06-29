/**
 * Manage units: single Save commits all renames + any newly-added units. The
 * "+ Add unit" button at the bottom appends a client-side row (with an X to
 * remove it before saving). No per-row Save button.
 */
import {
  appendRow, invalidate, nextId, readTab, updateRow,
} from "../sheets.js";
import { asInt, clear, flash, h } from "../util.js";

export default async function mountManageUnits(container) {
  clear(container);
  container.appendChild(h("h1", null, "Manage units"));
  container.appendChild(h("p", null,
    h("a", { class: "btn-secondary btn-sm", href: "#units" }, "← Back to units"),
  ));

  const loading = h("p", { class: "muted" }, "Loading…");
  container.appendChild(loading);

  const units = (await readTab("units"))
    .map((r) => ({ id: asInt(r.id), name: r.name || "", note: r.note || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));
  loading.remove();

  // Form container — every row reads its inputs at submit time.
  const rowsContainer = h("div");
  for (const u of units) {
    rowsContainer.appendChild(_existingRow(u));
  }
  container.appendChild(rowsContainer);

  const addBtn = h("button", {
    type: "button", class: "btn-secondary",
    onclick: () => {
      const row = _newRow();
      rowsContainer.appendChild(row);
      row.querySelector("input[name='name']").focus();
    },
  }, "+ Add unit");
  container.appendChild(h("p", null, addBtn));

  // Sticky save bar
  const saveBtn = h("button", {
    class: "btn",
    onclick: async () => {
      saveBtn.disabled = true;
      try {
        const summary = await _save(rowsContainer, units);
        if (summary) flash(summary);
        // re-mount to reflect the new state
        await mountManageUnits(container);
      } catch (e) {
        flash(`Save failed: ${e.message}`, "err");
      } finally {
        saveBtn.disabled = false;
      }
    },
  }, "Save");
  container.appendChild(h("div", { class: "sticky-save" },
    saveBtn,
    h("a", { class: "btn-secondary", href: "#units" }, "Cancel"),
  ));
}

function _existingRow(u) {
  const row = h("div", {
    class: "unit-row",
    "data-id": u.id,
    "data-note": u.note,
    style: { display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" },
  });
  const nameLabel = h("label",
    { style: { display: "inline-block", margin: "0", flex: "1 1 200px" } },
    "Name",
    h("br"),
    h("input", {
      name: "name", required: true, value: u.name,
      style: { width: "100%" },
    }),
  );
  row.appendChild(nameLabel);
  return row;
}

function _newRow() {
  const row = h("div", {
    class: "unit-row new",
    style: {
      display: "flex", gap: "0.5rem", alignItems: "flex-end",
      flexWrap: "wrap", borderStyle: "dashed", borderColor: "var(--muted)",
    },
  });
  const label = h("label",
    { style: { display: "inline-block", margin: "0", flex: "1 1 200px" } },
    "New unit name",
    h("br"),
    h("input", {
      name: "name", required: true, placeholder: "e.g. C3",
      style: { width: "100%" },
    }),
  );
  const remove = h("button", {
    type: "button", class: "btn-danger btn-sm",
    onclick: () => { if (confirm("Remove this unit?")) row.remove(); },
  }, "×");
  row.appendChild(label);
  row.appendChild(remove);
  return row;
}

async function _save(rowsContainer, originalUnits) {
  const rows = [...rowsContainer.querySelectorAll(".unit-row")];
  let renamed = 0, added = 0;
  const writes = [];
  // Refresh nextId from current tab (in case sheet changed underfoot).
  const currentRows = await readTab("units");
  let nextUnitId = nextId(currentRows);

  for (const row of rows) {
    const isNew = row.classList.contains("new");
    const nameInput = row.querySelector("input[name='name']");
    const name = (nameInput.value || "").trim();
    if (!name) continue; // skip blanks silently
    if (isNew) {
      writes.push(appendRow("units", {
        id: nextUnitId, name, note: "",
      }));
      nextUnitId++;
      added++;
    } else {
      const id = asInt(row.getAttribute("data-id"));
      const orig = originalUnits.find((u) => u.id === id);
      if (orig && orig.name !== name) {
        writes.push(updateRow("units", id, { name }));
        renamed++;
      }
    }
  }
  await Promise.all(writes);
  invalidate("units");
  if (!renamed && !added) return null;
  const parts = [];
  if (added) parts.push(`added ${added} unit${added === 1 ? "" : "s"}`);
  if (renamed) parts.push(`renamed ${renamed}`);
  return "Units: " + parts.join(", ") + ".";
}
