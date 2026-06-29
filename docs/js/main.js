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
} from "./auth.js";
import { OAUTH_CLIENT_ID, SHEET_ID } from "./config.js";
import { ForbiddenError, ensureTabs } from "./sheets.js";
import { clear, flash, h } from "./util.js";

import mountDashboard from "./pages/dashboard.js";

const ROUTES = {
  "": mountDashboard,
  "dashboard": mountDashboard,
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
  renderNav();
  onAuthChange(() => {
    renderNav();
    render();
  });
  window.addEventListener("hashchange", render);
  render();
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
  const route = (window.location.hash || "#dashboard").replace(/^#/, "").split("/")[0];
  const mount = ROUTES[route] || ROUTES["dashboard"];
  try {
    await mount(app);
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
