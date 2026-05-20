import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

# Load env from `.env` or `.env.txt` (Windows sometimes appends .txt).
_root = Path(__file__).resolve().parent.parent
for _candidate in (_root / ".env", _root / ".env.txt"):
    if _candidate.exists():
        load_dotenv(_candidate)
        break

from app.auth import auth_bp, current_email, init_oauth, is_admin  # noqa: E402
from app.billing import bill_due_date  # noqa: E402
from app.db import admin_email, init_db, seed_authorized_users  # noqa: E402
from app.routes import bp  # noqa: E402


def create_app() -> Flask:
    app = Flask(__name__)
    app.secret_key = os.environ.get("FLASK_SECRET_KEY", "dev-secret-change-me")
    init_db()
    seed_authorized_users()
    init_oauth(app)
    app.register_blueprint(bp)
    app.register_blueprint(auth_bp)
    app.jinja_env.globals["bill_due_date"] = bill_due_date
    app.jinja_env.globals["current_email"] = current_email
    app.jinja_env.globals["is_admin"] = is_admin
    app.jinja_env.globals["admin_email"] = admin_email()
    return app
