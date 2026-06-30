"""Run the SQLite -> Google Sheets migration using your *personal* Google login.

Unlike migrate_sqlite_to_sheets.main (which needs a service-account JSON), this
opens a browser, you sign in with the Google account that's shared on the sheet,
and the migration writes with your own credentials.

Reads OAUTH_CLIENT_ID, GOOGLE_CLIENT_SECRET and SHEET_ID from the environment
(or the project .env). The OAuth client must allow the loopback redirect URI
printed below as an "Authorized redirect URI". A token is cached next to this
script so subsequent runs don't reprompt.

Usage:
    uv run --with gspread --with google-auth-oauthlib \
        python scripts/migrate_oauth.py rental_prod.db
"""
from __future__ import annotations

import sys
from pathlib import Path

import gspread
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

from migrate_sqlite_to_sheets import migrate

# Only the spreadsheets scope is needed: open_by_key + read/write cells.
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
REDIRECT_PORT = 8765
TOKEN_PATH = Path(__file__).resolve().parent / ".sheets_token.json"


def _load_dotenv() -> dict[str, str]:
    env_path = Path(__file__).resolve().parent.parent / ".env"
    values: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def _get_credentials(client_id: str, client_secret: str) -> Credentials:
    if TOKEN_PATH.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
        if creds.valid:
            return creds
        if creds.expired and creds.refresh_token:
            creds.refresh(Request())
            TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
            return creds

    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [f"http://localhost:{REDIRECT_PORT}/"],
        }
    }
    flow = InstalledAppFlow.from_client_config(client_config, SCOPES)
    print(
        f"Opening a browser to sign in. If the OAuth client rejects the "
        f"redirect, add  http://localhost:{REDIRECT_PORT}/  to its "
        f"Authorized redirect URIs in Google Cloud Console."
    )
    creds = flow.run_local_server(port=REDIRECT_PORT, prompt="consent")
    TOKEN_PATH.write_text(creds.to_json(), encoding="utf-8")
    return creds


def main() -> None:
    sqlite_path = sys.argv[1] if len(sys.argv) > 1 else "rental.db"
    env = {**_load_dotenv()}
    # Real environment overrides .env.
    import os

    env.update({k: v for k, v in os.environ.items() if k in {
        "OAUTH_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SHEET_ID", "GOOGLE_SHEETS_ID",
    }})

    client_id = env.get("OAUTH_CLIENT_ID")
    client_secret = env.get("GOOGLE_CLIENT_SECRET")
    sheet_id = env.get("SHEET_ID") or env.get("GOOGLE_SHEETS_ID")
    if not client_id or not client_secret:
        raise SystemExit("OAUTH_CLIENT_ID and GOOGLE_CLIENT_SECRET are required")
    if not sheet_id:
        raise SystemExit("SHEET_ID (or GOOGLE_SHEETS_ID) is required")

    creds = _get_credentials(client_id, client_secret)
    gc = gspread.authorize(creds)
    sh = gc.open_by_key(sheet_id)
    print(f"opened sheet: {sh.title}")
    migrate(sh, sqlite_path)


if __name__ == "__main__":
    main()
