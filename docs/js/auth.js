/**
 * Google Identity Services (GIS) sign-in.
 *
 * Uses the token model: user clicks sign-in → consent popup → returns an
 * access token with the spreadsheets scope. The token is held only in memory
 * (NOT localStorage — short-lived secret). Auto-refresh happens transparently
 * via GIS when the token expires (~1 hour).
 *
 * The sheets module asks getAccessToken() before every request; if it returns
 * null (not signed in) callers render the sign-in UI instead.
 */
import { OAUTH_CLIENT_ID } from "./config.js";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets " +
              "https://www.googleapis.com/auth/userinfo.email";

let tokenClient = null;
let accessToken = null;
let accessTokenExpiresAt = 0;
let signInListeners = [];
let userEmail = null;

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
  await loadGisScript();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: SCOPE,
    callback: (resp) => {
      if (resp.error) {
        console.error("Auth error", resp);
        return;
      }
      accessToken = resp.access_token;
      accessTokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
      // Fetch the user's email for the nav badge (best-effort).
      fetchUserEmail().finally(() => {
        signInListeners.forEach((cb) => cb());
      });
    },
  });
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

/** Open the consent popup (prompt only on first sign-in). */
export function signIn() {
  if (!tokenClient) throw new Error("initAuth() must finish before signIn()");
  // empty prompt → silent if a valid grant exists, popup otherwise
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
}

export function signOut() {
  if (accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  accessTokenExpiresAt = 0;
  userEmail = null;
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
