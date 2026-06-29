/**
 * Categories management. In the static frontend "admin" is implicit — anyone
 * with Editor access to the sheet can edit; Viewer-shared accounts will hit a
 * 403 from the API on write attempts (Sheets enforces it).
 */
import { appendRow, deleteRow, invalidate, nextId, readTab } from "../sheets.js";
import { asInt, clear, flash, h } from "../util.js";

export default async function mountCategories(container) {
  clear(container);
  container.appendChild(h("h1", null, "Bill categories"));
  container.appendChild(h("p", { class: "muted" },
    "Categories available when creating bills. Removing a category does not " +
    "change bills already using it."));

  const loading = h("p", { class: "muted" }, "Loading…");
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
      const row = h("tr", null,
        h("td", null, c.name),
        h("td", null,
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
