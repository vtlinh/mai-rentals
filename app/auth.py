import os
from functools import wraps

from authlib.integrations.flask_client import OAuth
from flask import Blueprint, abort, flash, redirect, render_template, request, session, url_for

from app.db import admin_email, authorized_user_by_email

oauth = OAuth()
auth_bp = Blueprint("auth", __name__)


def init_oauth(app):
    oauth.init_app(app)
    oauth.register(
        name="google",
        client_id=os.environ.get("GOOGLE_CLIENT_ID"),
        client_secret=os.environ.get("GOOGLE_CLIENT_SECRET"),
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )


def current_email() -> str | None:
    return session.get("email")


def is_authorized(email: str) -> bool:
    return authorized_user_by_email(email) is not None


def is_admin(email: str | None) -> bool:
    admin = admin_email()
    return bool(admin) and email == admin


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        email = current_email()
        if not email or not is_authorized(email):
            return redirect(url_for("auth.login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin(current_email()):
            abort(403)
        return view(*args, **kwargs)

    return wrapped


@auth_bp.route("/login")
def login():
    session["post_login_next"] = request.args.get("next") or url_for("main.dashboard")
    if not os.environ.get("GOOGLE_CLIENT_ID"):
        return render_template("login.html", missing_config=True)
    redirect_uri = url_for("auth.callback", _external=True)
    return oauth.google.authorize_redirect(redirect_uri)


@auth_bp.route("/auth/callback")
def callback():
    token = oauth.google.authorize_access_token()
    userinfo = token.get("userinfo") or oauth.google.parse_id_token(token, None)
    email = (userinfo or {}).get("email", "").lower()
    if not email:
        flash("Could not read email from Google.")
        return redirect(url_for("auth.login"))
    if not is_authorized(email):
        flash(f"{email} is not authorized to view this site.")
        return render_template("forbidden.html", email=email), 403
    session["email"] = email
    return redirect(session.pop("post_login_next", url_for("main.dashboard")))


@auth_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))
