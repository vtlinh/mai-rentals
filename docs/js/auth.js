/**
 * Google Identity Services (GIS) sign-in.
 *
 * Staying signed in across reloads, in order of preference:
 *  1. Cached access token — the (short-lived, ~1h) token is stored in
 *     localStorage and restored on load, so a reload within its lifetime needs
 *     zero Google interaction. This is the reliable path: it works even when
 *     third-party-cookie policies (Safari, Chrome) block the silent handshake.
 *  2. Silent re-auth — once the cached token expires, we try a no-popup token
 *     request (prompt:none) using the existing Google session + prior consent.
 *     Best-effort; frequently blocked by cookie policy.
 *  3. Interactive — falls back to the "Sign in" button (consent screen only for
 *     first-time users).
 *
 * A true "remember forever" refresh token isn't possible in a pure static site
 * (Google only issues those to confidential clients with a backend), so the
 * short-lived token is the strongest credential available to persist. It's a
 * ~1h secret in localStorage — acceptable for this personal, sheet-share-gated
 * app — and is cleared on sign-out. The user re-consents only if they sign out
 * of Google, clear site data, or revoke access.
 */
import { OAUTH_CLIENT_ID } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets " +
              "https://www.googleapis.com/auth/userinfo.email";
const PREV_SIGNIN_KEY = "rental_prev_signin";
const TOKEN_KEY = "rental_token";              // cached access token (short-lived)
const REFRESH_LEAD_MS = 2 * 60 * 1000; // refresh ~2 min before expiry

let tokenClient = null;
let accessToken = null;
let accessTokenExpiresAt = 0;
let signInListeners = [];
let userEmail = null;
let pendingResolve = null;   // one-shot resolver for the in-flight token request
let refreshTimer = null;

/**
 * Load the GIS client library and prepare the token client. Resolves once
 * the library is ready (call before mounting any UI that needs auth).
 */
export async function initAuth() {
  if (!OAUTH_CLIENT_ID) {
    throw new Error(
      "OAUTH_CLIENT_ID is not set in docs/js/config.js — see the setup " +
      "instructions in that file."
    );
  }
  // Restore a still-valid cached token first, so a refresh within the token's
  // ~1h lifetime needs no Google round-trip at all (this is what makes reloads
  // instant even when third-party-cookie policies block silent re-auth).
  restoreSession();
  await loadGisScript();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        _settlePending({ ok: false, error: resp.error });
        return;
      }
      accessToken = resp.access_token;
      accessTokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      try { localStorage.setItem(PREV_SIGNIN_KEY, "1"); } catch (_) { /* ignore */ }
      _persistToken();
      _scheduleRefresh();
      // Fetch the user's email for the nav badge (best-effort), then notify.
      fetchUserEmail().finally(() => {
        _persistToken(); // re-store now that we have the email
        _settlePending({ ok: true });
        signInListeners.forEach((cb) => cb());
      });
    },
    // Fires for non-OAuth failures — notably when a silent (prompt:none)
    // request can't issue a token without interaction.
    error_callback: (err) => {
      _settlePending({ ok: false, error: err && err.type ? err.type : "error" });
    },
  });
}

function _settlePending(result) {
  if (pendingResolve) {
    const r = pendingResolve;
    pendingResolve = null;
    r(result);
  }
}

/**
 * Cache the current (short-lived) access token so a page reload within its
 * lifetime restores the session with no Google interaction. This stores a
 * ~1-hour secret in localStorage — acceptable for this personal, sheet-gated
 * app; the exposure window is one token lifetime and it's cleared on sign-out.
 */
function _persistToken() {
  try {
    if (!accessToken) return;
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      access_token: accessToken,
      expires_at: accessTokenExpiresAt,
      email: userEmail,
    }));
  } catch (_) { /* ignore */ }
}

/**
 * Load a cached token into memory if present and not near expiry. Returns true
 * if a usable session was restored. Called synchronously during initAuth.
 */
export function restoreSession() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return false;
    const t = JSON.parse(raw);
    if (!t.access_token || !t.expires_at) return false;
    if (Date.now() > t.expires_at - 60_000) {   // expired / about to expire
      localStorage.removeItem(TOKEN_KEY);
      return false;
    }
    accessToken = t.access_token;
    accessTokenExpiresAt = t.expires_at;
    userEmail = t.email || null;
    _scheduleRefresh();
    return true;
  } catch (_) {
    return false;
  }
}

function _requestToken(prompt) {
  return new Promise((resolve) => {
    pendingResolve = resolve;
    try {
      tokenClient.requestAccessToken({ prompt });
    } catch (e) {
      _settlePending({ ok: false, error: String(e) });
    }
  });
}

function _scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const ms = accessTokenExpiresAt - Date.now() - REFRESH_LEAD_MS;
  if (ms > 0) {
    refreshTimer = setTimeout(() => {
      // Silent refresh; if it fails the next Sheets call surfaces AuthError
      // and the UI falls back to the sign-in button.
      _requestToken("none");
    }, ms);
  }
}

function loadGisScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts) return resolve();
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.defer = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error("failed to load Google Identity Services"));
    document.head.appendChild(s);
  });
}

async function fetchUserEmail() {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.ok) {
      const data = await r.json();
      userEmail = data.email || null;
    }
  } catch (_) { /* ignore */ }
}

export function hasSignedInBefore() {
  try { return localStorage.getItem(PREV_SIGNIN_KEY) === "1"; } catch (_) { return false; }
}

/**
 * Attempt a no-UI sign-in using the existing Google session + prior consent.
 * Resolves true if a token was obtained silently, false otherwise (caller then
 * shows the interactive sign-in button). Only attempts if the user has
 * consented before, so first-time visitors aren't hit with a doomed request.
 */
export async function trySilentSignIn() {
  if (!tokenClient) throw new Error("initAuth() must finish before trySilentSignIn()");
  if (!hasSignedInBefore()) return false;
  // Guard against GIS never invoking either callback (rare) so the UI can't
  // hang on "Signing in…".
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 8000));
  const r = await Promise.race([_requestToken("none"), timeout]);
  return r.ok === true;
}

/** Open the interactive consent flow (used by the "Sign in" button). */
export function signIn() {
  if (!tokenClient) throw new Error("initAuth() must finish before signIn()");
  // Empty prompt reuses an existing grant silently when possible; first-timers
  // get the consent screen.
  _requestToken(hasSignedInBefore() ? "" : "consent");
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  accessTokenExpiresAt = 0;
  userEmail = null;
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
  try {
    localStorage.removeItem(PREV_SIGNIN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch (_) { /* ignore */ }
  signInListeners.forEach((cb) => cb());
}

/** Returns current access token, or null if not signed in / expired. */
export function getAccessToken() {
  if (!accessToken) return null;
  // Treat a token that expires in <60s as already expired so callers can
  // re-request rather than fire a doomed request.
  if (Date.now() > accessTokenExpiresAt - 60_000) return null;
  return accessToken;
}

export function isSignedIn() {
  return getAccessToken() !== null;
}

export function getUserEmail() {
  return userEmail;
}

/** Register a callback fired whenever sign-in state changes. */
export function onAuthChange(cb) {
  signInListeners.push(cb);
  return () => {
    signInListeners = signInListeners.filter((x) => x !== cb);
  };
}
