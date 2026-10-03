# Setup diagnostics: answers "why is nothing working?" in one JSON blob.
#
# Everything here is read-only and safe to poll. The egress-IP lookup is a
# network call, so results are cached for DIAGNOSTICS_TTL seconds (default 60)
# because the dashboard asks for this report on every page load.
import logging
import os
import time
from datetime import datetime, timezone

import coc_api
import coc_portal
from config import db, timeutil as tu

logger = logging.getLogger(__name__)

EGRESS_IP_URL = "https://api.ipify.org"
DEFAULT_TTL = 60
# Kept in sync with static/js/main.js: the offset the browser assumes before
# /api/status tells it the real one.
JS_DEFAULT_OFFSET = "+08:00"
TABLES = (
    "members",
    "wars",
    "war_attacks",
    "raid_weekends",
    "capital_raids",
    "sync_log",
    "member_contributions",
)
COMMON_ADMIN_KEYS = {
    "admin", "password", "letmein", "123456", "qwerty", "qwerty123",
    "qwerty1234", "qwerty2134", "secret", "changeme", "test",
}

_cache = {"at": 0.0, "value": None}


def _ttl():
    raw = os.environ.get("DIAGNOSTICS_TTL")
    if raw is None or str(raw).strip() == "":
        return DEFAULT_TTL
    try:
        return max(0, int(float(str(raw).strip())))
    except ValueError:
        return DEFAULT_TTL


def _flag(name, default=True):
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off")


def egress_ip():
    """This machine's public IP, as the CoC API will see it."""
    if not _flag("EGRESS_CHECK", True):
        return {"ip": None, "error": "disabled by EGRESS_CHECK=0"}
    if str(os.environ.get("VERCEL", "")).strip():
        return {
            "ip": None,
            "error": "skipped on Vercel: serverless egress IPs rotate, so an "
                     "IP whitelist cannot be trusted there",
        }
    try:
        import requests

        response = requests.get(
            os.environ.get("EGRESS_IP_LOOKUP_URL", EGRESS_IP_URL), timeout=10
        )
        response.raise_for_status()
        return {"ip": response.text.strip(), "error": None}
    except Exception as exc:  # a lookup failure must never break the report
        return {"ip": None, "error": f"lookup failed: {exc}"}


def api_status(probe=True):
    """Token presence, its claims (CIDRs/tier), the IP match, and a live probe."""
    token = os.environ.get("COC_API_TOKEN", "").strip()
    report = {
        "token_present": bool(token),
        "token_tail": token[-8:] or None,
        "issued_at": None,
        "scopes": [],
        "tier": None,
        "allowed_cidrs": [],
        "egress": egress_ip(),
        "match": None,
        "code": None,
        "message": None,
        "fix": None,
        "portal": coc_portal.PORTAL_PAGE,
        "live": None,
    }

    if not token:
        report["code"] = "TOKEN_MISSING"
        report["message"] = "COC_API_TOKEN is not set."
        report["fix"] = "Copy .env.example to .env and add COC_API_TOKEN."
        return report

    try:
        claims = coc_api.decode_token_claims(token)
        report["scopes"] = list(claims.get("scopes") or [])
        report["tier"] = coc_api.token_tier(token)
        report["allowed_cidrs"] = coc_api.token_cidrs(token)
    except coc_api.CocApiError as exc:
        report["code"] = "TOKEN_UNREADABLE"
        report["message"] = str(exc)
        report["fix"] = f"Create a fresh key at {coc_portal.PORTAL_PAGE}."
        return report

    issued = claims.get("iat")
    if isinstance(issued, (int, float)):
        report["issued_at"] = datetime.fromtimestamp(
            issued, timezone.utc
        ).isoformat(timespec="seconds")

    if not os.environ.get("CLAN_TAG", "").strip():
        report["code"] = "CLAN_TAG_MISSING"
        report["message"] = "CLAN_TAG is not set (needed for every clan call)."
        report["fix"] = "Add CLAN_TAG=#YOURCLANTAG to .env."
        return report

    current = report["egress"].get("ip")
    if current:
        report["match"] = coc_portal.ip_in_ranges(current, report["allowed_cidrs"])
        if not report["match"]:
            report["code"] = "IP_NOT_WHITELISTED"
            report["message"] = (
                f"This machine's public IP is {current}, but the key only allows "
                f"{', '.join(report['allowed_cidrs']) or 'nothing'}."
            )
            report["fix"] = "python scripts/refresh_key.py"
    else:
        report["code"] = "IP_UNKNOWN"

    # Only spend API calls when the local IP check did not already fail.
    if probe and report["code"] != "IP_NOT_WHITELISTED":
        try:
            clan = coc_api.get_clan()
            report["live"] = {
                "ok": True,
                "name": clan.get("name"),
                "tag": clan.get("tag"),
                "members": clan.get("members"),
            }
            report["code"] = "OK"
        except coc_api.CocApiError as exc:
            report["live"] = {
                "ok": False,
                "status": exc.status,
                "reason": exc.reason,
                "error": str(exc),
            }
            if exc.status == 403:
                report["code"] = "IP_NOT_WHITELISTED"
                report["message"] = (
                    "The key is not valid from this host (403). "
                    + (f"reason={exc.reason}. " if exc.reason else "")
                    + f"Key allows: {', '.join(exc.allowed_cidrs) or 'unknown'}."
                )
                report["fix"] = "python scripts/refresh_key.py"
            elif report["code"] in (None, "IP_UNKNOWN"):
                report["code"] = "LIVE_PROBE_FAILED"
                report["message"] = str(exc)
                report["fix"] = f"Check the key at {coc_portal.PORTAL_PAGE}."
    return report


def database_status():
    """Can we connect, and does every expected table exist (and how big)?"""
    backend = "postgresql" if db.is_postgres() else "mysql"
    report = {
        "backend": backend,
        "reachable": False,
        "tables": {},
        "error": None,
        "fix": None,
    }
    try:
        conn = db.get_connection()
    except Exception as exc:
        report["error"] = str(exc)[:300]
        report["fix"] = (
            r"Start MySQL from XAMPP (C:\xampp\mysql_start.bat)."
            if backend == "mysql"
            else "Check DATABASE_URL (Supabase pooler string) and PGSSLMODE."
        )
        return report

    try:
        cur = db.cursor(conn)
        for table in TABLES:
            try:
                cur.execute(f"SELECT COUNT(*) AS n FROM {table}")
                row = cur.fetchone()
                report["tables"][table] = int(row["n"]) if row else 0
                report["reachable"] = True
            except Exception as exc:
                report["tables"][table] = None
                report["error"] = report["error"] or f"{table}: {str(exc)[:120]}"
                try:  # a failed statement poisons the Postgres transaction
                    conn.rollback()
                except Exception:
                    break
        cur.close()
    finally:
        conn.close()

    if not any(count is not None for count in report["tables"].values()):
        report["reachable"] = False
        report["fix"] = (
            "The schema is missing - run schema.mysql.sql in MySQL."
            if backend == "mysql"
            else "The schema is missing - run schema.postgres.sql in Supabase."
        )
    return report


def timezone_status():
    """The zone days are bucketed in, versus what the browser assumes."""
    info = tu.tz_info()
    return {
        "effective_offset": info["utc_offset"],
        "tz_name": info["tz_name"],
        "source": info["source"],
        "tz_env": info["tz_env"],
        "today": info["today"],
        "contrib_snapshot_hours": info["contrib_snapshot_hours"],
        "js_default_offset": JS_DEFAULT_OFFSET,
        "match": info["utc_offset"] == JS_DEFAULT_OFFSET,
    }


def admin_key_status():
    """Presence and strength of ADMIN_KEY (the app password, not the API key)."""
    key = os.environ.get("ADMIN_KEY", "").strip()
    weak = bool(key) and (len(key) < 12 or key.lower() in COMMON_ADMIN_KEYS)
    return {
        "present": bool(key),
        "weak": weak,
        "length": len(key),
        "hint": (
            "Pick 3+ unrelated words (20+ chars), e.g. "
            "`python -c \"import secrets; print(secrets.token_urlsafe(24))\"`."
            if weak
            else None
        ),
    }


def _problems(report):
    """Everything that is currently broken, with a fix command for each."""
    problems = []
    api = report["api"]
    if api["code"] in (
        "TOKEN_MISSING", "TOKEN_UNREADABLE", "CLAN_TAG_MISSING", "IP_NOT_WHITELISTED",
    ):
        problems.append({
            "area": "coc_api", "code": api["code"],
            "message": api["message"], "fix": api["fix"],
        })
    elif api["live"] and not api["live"]["ok"]:
        problems.append({
            "area": "coc_api", "code": "LIVE_PROBE_FAILED",
            "message": api["live"].get("error"),
            "fix": api["fix"] or f"Check the key at {coc_portal.PORTAL_PAGE}.",
        })
    if not report["database"]["reachable"]:
        problems.append({
            "area": "database", "code": "DB_UNREACHABLE",
            "message": report["database"]["error"],
            "fix": report["database"]["fix"],
        })
    tz = report["timezone"]
    if not tz["match"]:
        problems.append({
            "area": "timezone", "code": "TZ_MISMATCH",
            "message": (
                f"Days are bucketed in UTC{tz['effective_offset']} but the UI "
                f"defaults to UTC{JS_DEFAULT_OFFSET}."
            ),
            "fix": "Set APP_UTC_OFFSET=+08:00 in the server environment.",
        })
    if report["admin_key"]["weak"]:
        problems.append({
            "area": "admin_key", "code": "WEAK_ADMIN_KEY",
            "message": "ADMIN_KEY is short or guessable.",
            "fix": report["admin_key"]["hint"],
        })
    return problems


def collect(probe=True, use_cache=True):
    """The whole report, cached for DIAGNOSTICS_TTL seconds."""
    now = time.time()
    ttl = _ttl()
    if use_cache and ttl > 0 and _cache["value"] is not None:
        if (now - _cache["at"]) < ttl:
            return _cache["value"]

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "api": api_status(probe=probe),
        "database": database_status(),
        "timezone": timezone_status(),
        "admin_key": admin_key_status(),
    }
    report["problems"] = _problems(report)
    report["ok"] = not report["problems"]
    _cache["at"] = now
    _cache["value"] = report
    return report


def clear_cache():
    """Test helper / admin use."""
    _cache["at"] = 0.0
    _cache["value"] = None
