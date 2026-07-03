/**
 * Units list (read-only overview). Each unit shows its name, its occupancies
 * (sorted by start_date), and a "Manage occupancy" button. A "Manage units"
 * button at the top opens the rename/add page.
 */
import { readAll } from "../sheets.js";
import { asInt, clear, formatDate, h, parseDate } from "../util.js";

export default async function mountUnits(container) {
  clear(container);
  container.appendChild(h("h1", null, "Units"));
  container.appendChild(h("p", { class: "actions" },
    h("a", { class: "btn-secondary", href: "#units/manage" }, "Manage units"),
  ));

  const loading = h("p", { class: "loading" }, "Loading…");
  container.appendChild(loading);

  const data = await readAll();
  loading.remove();

  const units = (data.units || [])
    .map((r) => ({ id: asInt(r.id), name: r.name || "", note: r.note || "" }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const occsByUnit = new Map();
  for (const r of (data.occupancies || [])) {
    const uid = asInt(r.unit_id);
    if (!occsByUnit.has(uid)) occsByUnit.set(uid, []);
    occsByUnit.get(uid).push({
      id: asInt(r.id),
      tenant_count: asInt(r.tenant_count),
      start_date: parseDate(r.start_date),
      end_date: parseDate(r.end_date),
    });
  }

  if (!units.length) {
    container.appendChild(h("div", { class: "empty-state" },
      h("p", null, "No units yet."),
      h("a", { class: "btn", href: "#units/manage" }, "Manage units")));
    return;
  }

  for (const u of units) {
    const card = h("div", { class: "card" },
      h("h2", { style: { margin: "0 0 0.5rem 0" } }, u.name),
    );
    if (u.note) card.appendChild(h("p", { class: "muted" }, u.note));

    const occs = (occsByUnit.get(u.id) || [])
      .sort((a, b) => a.start_date - b.start_date);
    const tbl = h("table");
    tbl.appendChild(h("tr", null,
      h("th", null, "Tenants"),
      h("th", null, "Start"),
      h("th", null, "End (inclusive)"),
    ));
    if (occs.length) {
      for (const o of occs) {
        tbl.appendChild(h("tr", null,
          h("td", null, String(o.tenant_count)),
          h("td", null, formatDate(o.start_date)),
          h("td", null, formatDate(o.end_date)),
        ));
      }
    } else {
      tbl.appendChild(h("tr", null,
        h("td", { class: "muted", colspan: "3" }, "No occupancies."),
      ));
    }
    card.appendChild(tbl);
    card.appendChild(h("p", { class: "actions" },
      h("a", {
        class: "btn-secondary btn-sm",
        href: `#units/${u.id}/edit`,
      }, "Manage occupancy"),
    ));
    container.appendChild(card);
  }
}
