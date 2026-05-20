import os

from flask import Flask

from app.auth import auth_bp, current_email, init_oauth, is_admin
from app.billing import bill_due_date
from app.db import ADMIN_EMAIL, init_db, seed_authorized_users
from app.routes import bp


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
    app.jinja_env.globals["admin_email"] = ADMIN_EMAIL
    return app
