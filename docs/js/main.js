/**
 * Entry point: bootstraps auth, renders the persistent nav, and routes between
 * hash-addressed pages (#dashboard, #units, #bills, …). Each page module
 * exports a default mount(container) function.
 *
 * Auth: until the user signs in, every page is replaced with the sign-in
 * stub. After sign-in, hash changes call the routed module's mount().
 */
import {
  initAuth, signIn, signOut, isSignedIn, getUserEmail, onAuthChange,
  trySilentSignIn, hasSignedInBefore,
} from "./auth.js";
import { OAUTH_CLIENT_ID, SHEET_ID } from "./config.js";
import { ForbiddenError, ensureTabs } from "./sheets.js";
import { clear, flash, h } from "./util.js";

import mountBillForm from "./pages/bill_form.js";
import mountBills from "./pages/bills.js";
import mountCategories from "./pages/categories.js";
import mountDashboard from "./pages/dashboard.js";
import mountManageOccupancy from "./pages/manage_occupancy.js";
import mountManageUnits from "./pages/manage_units.js";
import mountPaymentForm from "./pages/payment_form.js";
import mountPdf from "./pages/pdf.js";
import mountRecurringForm from "./pages/recurring_form.js";
import mountUnits from "./pages/units.js";

/**
 * Each route handler takes (container, params, query). Params is the array of
 * remaining hash segments (e.g. for "#units/42/edit": route="units",
 * params=["42", "edit"]). Query is a URLSearchParams parsed from any "?…"
 * suffix on the hash. Routes with sub-segments dispatch inside the mount.
 */
const ROUTES = {
  "": mountDashboard,
  "dashboard": mountDashboard,
  "units": (container, params) => {
    if (params[0] === "manage") return mountManageUnits(container);
    if (params.length >= 2 && params[1] === "edit") {
      return mountManageOccupancy(container, params);
    }
    return mountUnits(container);
  },
  "bills": (container, params) => {
    if (params[0] === "new") return mountBillForm(container, ["new"]);
    if (params.length >= 2 && params[1] === "edit") {
      return mountBillForm(container, params);
    }
    return mountBills(container);
  },
  "recurring": (container, params, query) => {
    if (params[0] === "new") return mountRecurringForm(container, ["new"], query);
    if (params.length >= 2 && params[1] === "edit") {
      return mountRecurringForm(container, params, query);
    }
    // No standalone recurring list page — recurring lives on #bills.
    window.location.hash = "#bills";
    return Promise.resolve();
  },
  "categories": mountCategories,
  "payment": (container, params) => mountPaymentForm(container, params),
  "pdf": mountPdf,
};

async function boot() {
  if (!OAUTH_CLIENT_ID || !SHEET_ID) {
    renderConfigStub();
    return;
  }
  try {
    await initAuth();
  } catch (e) {
    renderError(e.message);
    return;
  }
  onAuthChange(() => {
    renderNav();
    render();
  });
  window.addEventListener("hashchange", render);

  // If the user has signed in before, try to restore the session silently
  // (no popup) before painting the sign-in stub, so returning visits skip the
  // "Sign in" click entirely.
  renderNav();
  if (!isSignedIn() && hasSignedInBefore()) {
    renderSigningIn(document.getElementById("app"));
    await trySilentSignIn();  // onAuthChange re-renders on success
  }
  if (!isSignedIn()) render();
}

function renderSigningIn(app) {
  clear(app);
  app.appendChild(h("p", { class: "muted" }, "Signing in…"));
}

function renderNav() {
  const nav = document.getElementById("nav");
  clear(nav);
  nav.appendChild(h("strong", null, "Rental"));
  if (isSignedIn()) {
    nav.appendChild(navLink("#dashboard", "Dashboard"));
    nav.appendChild(navLink("#units", "Units"));
    nav.appendChild(navLink("#bills", "Bills"));
    nav.appendChild(h("span", { class: "spacer" }));
    const email = getUserEmail();
    if (email) nav.appendChild(h("span", { class: "muted" }, email));
    nav.appendChild(h("button", { class: "btn-secondary btn-sm", onclick: signOut }, "Log out"));
  } else {
    nav.appendChild(h("span", { class: "spacer" }));
    nav.appendChild(h("button", { class: "btn", onclick: signIn }, "Sign in with Google"));
  }
}

function navLink(href, label) {
  return h("a", { href }, label);
}

async function render() {
  const app = document.getElementById("app");
  clear(app);
  if (!isSignedIn()) {
    renderSignInStub(app);
    return;
  }
  // Split the hash into "<path>?<query>"; path segments are slash-delimited.
  const rawHash = (window.location.hash || "#dashboard").replace(/^#/, "");
  const qIndex = rawHash.indexOf("?");
  const pathPart = qIndex === -1 ? rawHash : rawHash.slice(0, qIndex);
  const query = new URLSearchParams(qIndex === -1 ? "" : rawHash.slice(qIndex + 1));
  const segments = pathPart.split("/");
  const route = segments[0] || "dashboard";
  const params = segments.slice(1);
  const mount = ROUTES[route] || ROUTES["dashboard"];
  try {
    await mount(app, params, query);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      renderForbidden(app, e.message);
    } else if (e.name === "AuthError") {
      renderSignInStub(app);
    } else {
      console.error(e);
      flash(`Error: ${e.message}`, "err");
    }
  }
}

function renderSignInStub(app) {
  app.appendChild(h("h1", null, "Sign in"));
  app.appendChild(h("p", null,
    "Sign in with the Google account you've been granted access to. " +
    "Access is enforced by the sheet's share list — if your account " +
    "isn't shared on it, you won't be able to load any data."));
  app.appendChild(h("p", null,
    h("button", { class: "btn", onclick: signIn }, "Sign in with Google")));
}

function renderForbidden(app, msg) {
  clear(app);
  app.appendChild(h("h1", null, "Not authorized"));
  app.appendChild(h("p", null, msg));
  app.appendChild(h("p", { class: "muted" },
    "Ask the sheet owner to share the spreadsheet with your Google account."));
  app.appendChild(h("p", null,
    h("button", { class: "btn-secondary", onclick: signOut }, "Sign out")));
}

function renderConfigStub() {
  const app = document.getElementById("app");
  clear(app);
  app.appendChild(h("h1", null, "Configuration needed"));
  app.appendChild(h("p", null,
    "Set OAUTH_CLIENT_ID and SHEET_ID in docs/js/config.js, then reload."));
  app.appendChild(h("p", { class: "muted" },
    "Setup steps are at the top of that file."));
}

function renderError(msg) {
  const app = document.getElementById("app");
  clear(app);
  app.appendChild(h("h1", null, "Error"));
  app.appendChild(h("p", { class: "flash err" }, msg));
}

// One-off helper: initialize all tabs on the sheet. Called from console.
window._ensureTabs = ensureTabs;

boot();
