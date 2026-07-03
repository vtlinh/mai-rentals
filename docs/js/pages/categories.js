/**
 * Categories management. In the static frontend "admin" is implicit — anyone
 * with Editor access to the sheet can edit; Viewer-shared accounts will hit a
 * 403 from the API on write attempts (Sheets enforces it).
 */
import {
  appendRow, deleteRow, invalidate, nextId, readAll, readTab, updateRow,
} from "../sheets.js";
import { renameKindCascade } from "../cascade.js";
import { asInt, clear, flash, h } from "../util.js";

export default async function mountCategories(container) {
  clear(container);
  container.appendChild(h("h1", null, "Bill categories"));
  container.appendChild(h("p", { class: "muted" },
    "Categories available when creating bills. Renaming a category renames it " +
    "on every bill, recurring bill, payment, and covered-utilities list that " +
    "uses it. Removing one does not change bills already using it."));

  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);
  const rows = await readTab("categories");
  loading.remove();

  const list = h("table");
  list.appendChild(h("tr", null, h("th", null, "Name"), h("th", null, "")));
  const cats = rows
    .map((r) => ({ id: asInt(r.id), name: (r.name || "").trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!cats.length) {
    list.appendChild(h("tr", null,
      h("td", { class: "muted", colspan: "2" }, "No categories yet.")));
  } else {
    for (const c of cats) {
      const nameInput = h("input", {
        value: c.name, required: true,
        style: { minWidth: "auto", width: "12rem" },
      });
      const renameBtn = h("button", {
        class: "btn-secondary btn-sm", type: "button",
        onclick: async () => {
          const newName = (nameInput.value || "").trim().toLowerCase();
          if (!newName) { flash("Category name is required.", "err"); return; }
          if (newName === c.name.toLowerCase()) return;
          const current = await readTab("categories");
          if (current.some((r) => asInt(r.id) !== c.id &&
              (r.name || "").trim().toLowerCase() === newName)) {
            flash(`'${newName}' already exists.`, "err");
            return;
          }
          if (!confirm(`Rename '${c.name}' to '${newName}'? Every bill, ` +
              "recurring bill, payment, and covered-utilities list using it " +
              "will be renamed too.")) return;
          renameBtn.disabled = true;
          try {
            // Cascade first, categories row last: a partial failure leaves the
            // old name in place so the rename can simply be retried.
            const counts = await renameKindCascade(c.name, newName, await readAll());
            await updateRow("categories", c.id, { name: newName });
            invalidate();
            const touched = counts.bills + counts.recurring_bills +
              counts.payments + counts.occupancies;
            flash(`Renamed '${c.name}' to '${newName}'` +
              (touched ? ` (${touched} row${touched === 1 ? "" : "s"} updated)` : "") + ".");
            await mountCategories(container);
          } catch (e) {
            flash(`Rename failed: ${e.message}`, "err");
          } finally {
            renameBtn.disabled = false;
          }
        },
      }, "rename");
      const row = h("tr", null,
        h("td", null, nameInput),
        h("td", null,
          renameBtn,
          " ",
          h("button", {
            class: "btn-danger btn-sm", type: "button",
            onclick: async () => {
              if (!confirm(`Remove category '${c.name}'?`)) return;
              try {
                await deleteRow("categories", c.id);
                invalidate("categories");
                flash(`Removed category '${c.name}'.`);
                row.remove();
              } catch (e) {
                flash(`Delete failed: ${e.message}`, "err");
              }
            },
          }, "delete")));
      list.appendChild(row);
    }
  }
  container.appendChild(list);

  container.appendChild(h("h2", null, "Add category"));
  const nameInput = h("input", { name: "name", required: true, placeholder: "e.g. water" });
  const addForm = h("form", {
    style: { display: "flex", gap: "0.5rem", alignItems: "flex-end", flexWrap: "wrap" },
    onsubmit: async (e) => {
      e.preventDefault();
      const name = (nameInput.value || "").trim().toLowerCase();
      if (!name) { flash("Category name is required.", "err"); return; }
      // Refresh rows to check for duplicates atomically with the insert.
      const current = await readTab("categories");
      if (current.some((r) => (r.name || "").trim().toLowerCase() === name)) {
        flash(`'${name}' already exists.`, "err");
        return;
      }
      try {
        await appendRow("categories", { id: nextId(current), name });
        invalidate("categories");
        flash(`Added category '${name}'.`);
        await mountCategories(container);
      } catch (err) {
        flash(`Add failed: ${err.message}`, "err");
      }
    },
  },
    h("label", { style: { margin: "0" } }, "New category", h("br"), nameInput),
    h("button", { class: "btn", type: "submit" }, "Add category"),
  );
  container.appendChild(addForm);

  container.appendChild(h("p", { style: { marginTop: "1.5rem" } },
    h("a", { class: "btn-secondary", href: "#bills" }, "Back to bills")));
}
