# CoC Attack Tracker — Flask application (local entrypoint).
# api/index.py re-exports `app` for Vercel's Python runtime.
import hmac
import logging
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone

from flask import Flask, jsonify, render_template, request
from dotenv import load_dotenv

from config import db, timeutil as tu
import diagnostics
import runtime_state
import sync as syncer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)


def _local_sync_allowed():
    """True when a request may skip the admin key because it comes from here.

    Single-owner app: on the machine that runs it, typing a key on every refresh
    is friction with no security value (the app is already loopback-only). Set
    ALLOW_LOCAL_SYNC=0 to require the key everywhere - important if you ever
    expose this app through a tunnel or reverse proxy.
    """
    if str(os.environ.get("ALLOW_LOCAL_SYNC", "1")).strip().lower() in (
        "0", "false", "no", "off",
    ):
        return False
    return request.remote_addr in ("127.0.0.1", "::1", "localhost")


def _admin_ok():
    """True when the caller may run admin actions (sync, notes).

    Trust order:
      1. a request from this machine while ALLOW_LOCAL_SYNC is on, then
      2. X-Admin-Key compared against ADMIN_KEY in constant time.
    """
    if _local_sync_allowed():
        return True
    expected = os.environ.get("ADMIN_KEY", "").strip()
    provided = request.headers.get("X-Admin-Key", "").strip()
    if not expected or not provided:
        return False
    return hmac.compare_digest(provided, expected)


def _query_all(sql, params=()):
    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute(sql, params)
    rows = [dict(r) for r in cur.fetchall()]
    cur.close()
    conn.close()
    return rows


def _iso_local(value):
    """Render a stored (UTC) timestamp in the app timezone for the UI."""
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(tu.app_tz()).isoformat(timespec="minutes")


def _span_hours(start_iso, end_iso):
    """Hours between two local ISO timestamps (None when unavailable)."""
    if not start_iso or not end_iso:
        return None
    try:
        start = datetime.fromisoformat(start_iso)
        end = datetime.fromisoformat(end_iso)
    except ValueError:
        return None
    return round((end - start).total_seconds() / 3600, 1)


def _hours_since(iso_string):
    """Hours between a local ISO timestamp and now (None when unavailable)."""
    if not iso_string:
        return None
    try:
        start = datetime.fromisoformat(iso_string)
    except (ValueError, TypeError):
        return None
    if start.tzinfo is None:
        start = start.replace(tzinfo=tu.app_tz())
    return round((datetime.now(tu.app_tz()) - start).total_seconds() / 3600, 1)


def _contribution_days():
    """Per-member daily rows with the 24h window each figure belongs to.

    A day is scored from two consecutive *baselines* — the first reading taken
    on each local day. Because baseline(D) is captured at the start of day D,
    ``baseline(D+1) - baseline(D)`` is what the member donated **during day D**,
    i.e. the window [captured_at(D), captured_at(D+1)]. A day therefore becomes
    final once the next day's baseline exists.
    """
    rows = _query_all("SELECT * FROM member_contributions ORDER BY member_tag, day")
    by_member = {}
    for row in rows:
        tag = row.get("member_tag")
        if not tag:
            continue
        entry = by_member.setdefault(tag, {"name": row.get("member_name"), "days": []})
        if row.get("member_name"):
            entry["name"] = row["member_name"]
        baseline = int(row.get("total_contributions") or 0)
        latest = row.get("latest_contributions")
        entry["days"].append({
            "day": str(row.get("day")),
            "baseline": baseline,
            "latest": baseline if latest is None else int(latest),
            "captured_at": _iso_local(row.get("captured_at")),
            "latest_at": _iso_local(row.get("latest_at")),
        })

    history = {}
    day_totals = {}
    for tag, entry in by_member.items():
        days = sorted(entry["days"], key=lambda item: item["day"])
        for index in range(len(days) - 1):
            current, following = days[index], days[index + 1]
            delta = following["baseline"] - current["baseline"]
            current["window_from"] = current["captured_at"]
            current["window_to"] = following["captured_at"]
            current["span_hours"] = _span_hours(
                current["captured_at"], following["captured_at"]
            )
            if delta < 0:
                # The counter is tied to current clan membership: a drop means
                # the member left and rejoined (or the counter reset), so the
                # amount donated in this window is unknown.
                current["donated"] = 0
                current["reset"] = True
            else:
                current["donated"] = delta
                current["reset"] = False
            day_totals.setdefault(current["day"], {})[tag] = current["donated"]
        deepest = days[-1]
        deepest.setdefault("window_from", None)
        deepest.setdefault("window_to", None)
        deepest.setdefault("span_hours", None)
        deepest.setdefault("donated", None)  # open window: not scored yet
        deepest.setdefault("reset", False)
        history[tag] = days
    return by_member, history, day_totals


@app.context_processor
def _globals():
    return {"clan_name": os.environ.get("CLAN_NAME", "Clan")}


@app.route("/")
def dashboard():
    clan = None
    error = None
    try:
        import coc_api

        clan = coc_api.get_clan()
    except Exception as exc:
        error = str(exc)

    try:
        wars = _query_all(
            "SELECT * FROM wars ORDER BY COALESCE(end_time, start_time) DESC LIMIT 5"
        )
        raids = _query_all(
            "SELECT * FROM raid_weekends ORDER BY start_time DESC LIMIT 5"
        )
        members = _query_all(
            "SELECT * FROM members ORDER BY trophies DESC LIMIT 10"
        )
    except Exception as exc:
        wars, raids, members = [], [], []
        error = error or f"Database: {exc}"

    return render_template(
        "index.html", clan=clan, wars=wars, raids=raids,
        members=members, error=error,
    )


@app.route("/wars")
def wars_page():
    return render_template("wars.html")


@app.route("/capital")
def capital_page():
    return render_template("capital.html")


@app.route("/members")
def members_page():
    return render_template("members.html")


@app.route("/health")
def health():
    try:
        db.healthcheck()
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"status": "error", "detail": str(exc)}), 500


@app.route("/api/clan")
def api_clan():
    try:
        import coc_api

        return jsonify(coc_api.get_clan())
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


@app.route("/api/members")
def api_members():
    return jsonify(_query_all("SELECT * FROM members ORDER BY trophies DESC"))


@app.route("/api/members/profile")
def api_member_profile():
    """One member's tracked history: wars, stars, perfects, capital loot.

    "Missed attacks" compares the attacks the member actually used in each
    tracked war against the war format's cap (1 in CWL, else 2) - it can only
    cover wars that were synced while live, since the warlog exposes no
    per-attack data for older wars.
    """
    tag = request.args.get("tag", "").strip()
    if not tag:
        return jsonify({"error": "tag is required"}), 400
    rows = _query_all("SELECT * FROM members WHERE tag = %s", (tag,))
    if not rows:
        return jsonify({"error": "unknown member"}), 404

    war_rows = _query_all(
        """
        SELECT wa.war_id, w.is_cwl, w.result, w.opponent_name, w.end_time,
               COUNT(*) AS attacks, SUM(wa.stars) AS stars,
               SUM(CASE WHEN wa.stars = 3 THEN 1 ELSE 0 END) AS perfects,
               AVG(wa.destruction) AS avg_destruction
        FROM war_attacks wa JOIN wars w ON w.id = wa.war_id
        WHERE wa.side = 'clan' AND wa.attacker_tag = %s
        GROUP BY wa.war_id, w.is_cwl, w.result, w.opponent_name, w.end_time
        ORDER BY w.end_time DESC
        """,
        (tag,),
    )
    wars_played = len(war_rows)
    attacks_used = sum(int(r["attacks"] or 0) for r in war_rows)
    cap = sum((1 if r["is_cwl"] else 2) for r in war_rows)
    raid_rows = _query_all(
        """
        SELECT COUNT(*) AS weekends, COALESCE(SUM(cr.attacks), 0) AS attacks,
               COALESCE(SUM(cr.capital_gold), 0) AS capital_gold,
               COALESCE(SUM(cr.raid_medals), 0) AS raid_medals
        FROM capital_raids cr WHERE cr.member_tag = %s
        """,
        (tag,),
    )[0]
    return jsonify({
        "member": rows[0],
        "wars": {
            "played": wars_played,
            "attacks_used": attacks_used,
            "attacks_missed": max(0, cap - attacks_used),
            "stars": sum(int(r["stars"] or 0) for r in war_rows),
            "perfects": sum(int(r["perfects"] or 0) for r in war_rows),
            "avg_destruction": (
                round(sum(float(r["avg_destruction"] or 0) for r in war_rows)
                      / wars_played, 1) if wars_played else None
            ),
            "detail": war_rows,
        },
        "capital": {
            "weekends": int(raid_rows["weekends"] or 0),
            "attacks": int(raid_rows["attacks"] or 0),
            "capital_gold": int(raid_rows["capital_gold"] or 0),
            "raid_medals": int(raid_rows["raid_medals"] or 0),
        },
    })


@app.route("/api/wars")
def api_wars():
    return jsonify(
        _query_all("SELECT * FROM wars ORDER BY COALESCE(end_time, start_time) DESC")
    )


@app.route("/api/capital")
def api_capital():
    return jsonify(
        _query_all("SELECT * FROM raid_weekends ORDER BY start_time DESC")
    )


@app.route("/api/current-war")
def api_current_war():
    """The war happening right now (preparation or inWar), plus its attacks."""
    rows = _query_all(
        "SELECT * FROM wars WHERE result IN ('preparation', 'inProgress') "
        "ORDER BY COALESCE(end_time, start_time) DESC LIMIT 1"
    )
    if not rows:
        return jsonify({"in_war": False})
    current = rows[0]
    attacks = _query_all(
        "SELECT * FROM war_attacks WHERE war_id = %s", (current["id"],)
    )
    attacks.sort(key=lambda a: a.get("order") or 0)
    return jsonify({
        "in_war": True,
        "war": current,
        "attacks": attacks,
        "clan_attacks": [a for a in attacks if a.get("side") == "clan"],
        "enemy_attacks": [a for a in attacks if a.get("side") != "clan"],
    })


@app.route("/api/capital/participation")
def api_capital_participation():
    raid_id = request.args.get("raid_id", type=int)
    if not raid_id:
        rows = _query_all("SELECT id FROM raid_weekends ORDER BY start_time DESC LIMIT 1")
        if not rows:
            return jsonify({"error": "No raid weekends synced yet"}), 404
        raid_id = rows[0]["id"]
    raid = _query_all("SELECT * FROM raid_weekends WHERE id = %s", (raid_id,))
    raiders = _query_all("SELECT * FROM capital_raids WHERE raid_id = %s", (raid_id,))
    # Defensive: keep one row per member tag (rows written before the unique
    # constraint existed may contain duplicates).
    seen_tags = set()
    unique_raiders = []
    for r in sorted(raiders, key=lambda x: x.get("id") or 0):
        tag = r.get("member_tag")
        if tag in seen_tags:
            continue
        seen_tags.add(tag)
        unique_raiders.append(r)
    raiders = unique_raiders
    roster = _query_all("SELECT tag, name FROM members ORDER BY name")
    attacked_tags = {r.get("member_tag") for r in raiders}
    not_attacked = [m for m in roster if m.get("tag") not in attacked_tags]
    raiders.sort(key=lambda r: -(r.get("capital_gold") or 0))
    return jsonify({
        "raid": raid[0] if raid else None,
        "attacked": raiders,
        "not_attacked": not_attacked,
    })


@app.route("/api/wars/<int:war_id>/attacks")
def api_war_attacks(war_id):
    """Attacks for one war, split by side (used by the expandable rows)."""
    attacks = _query_all("SELECT * FROM war_attacks WHERE war_id = %s", (war_id,))
    # `order` is a reserved word in both dialects, so sort in Python.
    attacks.sort(key=lambda a: a.get("order") or 0)
    return jsonify({
        "war_id": war_id,
        "attacks": attacks,
        "clan_attacks": [a for a in attacks if a.get("side") == "clan"],
        "enemy_attacks": [a for a in attacks if a.get("side") != "clan"],
    })


@app.route("/api/capital/<int:raid_id>/raiders")
def api_capital_raiders(raid_id):
    """Per-member breakdown for one raid weekend (expandable history rows)."""
    raiders = _query_all("SELECT * FROM capital_raids WHERE raid_id = %s", (raid_id,))
    seen_tags = set()
    unique_raiders = []
    for r in sorted(raiders, key=lambda x: x.get("id") or 0):
        tag = r.get("member_tag")
        if tag in seen_tags:
            continue
        seen_tags.add(tag)
        unique_raiders.append(r)
    unique_raiders.sort(key=lambda r: -(r.get("capital_gold") or 0))
    return jsonify({"raid_id": raid_id, "raiders": unique_raiders})


@app.route("/api/status")
def api_status():
    """Sync health: last sync entries and whether auto-sync is enabled."""
    try:
        recent = _query_all("SELECT * FROM sync_log ORDER BY id DESC LIMIT 20")
    except Exception as exc:
        recent = []
        api_status_error = str(exc)
    else:
        api_status_error = None
    minutes = _auto_sync_minutes()
    on_vercel = bool(os.environ.get("VERCEL"))
    tz = tu.tz_info()
    payload = {
        "auto_sync_minutes": minutes,
        "auto_sync_enabled": (minutes > 0) and not on_vercel,
        "cron_enabled": on_vercel,
        # Which day contributions are being recorded under, and in what zone.
        "server_now": tz["now"],
        "server_utc_offset": tz["utc_offset"],
        "server_tz_name": tz["tz_name"],
        "server_tz_source": tz["source"],
        "server_tz_env": tz["tz_env"],
        "today": tz["today"],
        "contrib_snapshot_hours": tz["contrib_snapshot_hours"],
        "last_sync": recent[0] if recent else None,
        "recent": recent,
        # In-memory, so it still explains a failure when the database is down
        # and the attempt could not be written to sync_log.
        "last_attempt": runtime_state.last_sync(),
        "admin_key": diagnostics.admin_key_status(),
        "local_sync_allowed": _local_sync_allowed(),
    }
    if api_status_error:
        payload["error"] = api_status_error
    return jsonify(payload)


@app.route("/api/contributions")
def api_contributions():
    """Daily capital-coin donations, bucketed by the app's local day.

    The game only exposes a *lifetime* contribution total per player, so daily
    amounts are the difference between consecutive daily baselines captured by
    this app (one API call per member per day).
    """
    requested = (request.args.get("day") or "").strip()
    # Include members that have contribution history but are no longer on the
    # roster: silently dropping them would erase a day they actually donated on.
    roster = _query_all("SELECT tag, name FROM members")
    known = {m["tag"]: {"tag": m["tag"], "name": m.get("name"), "departed": False}
             for m in roster}
    by_member, history, day_totals = _contribution_days()
    for tag, entry in by_member.items():
        if tag not in known:
            known[tag] = {
                "tag": tag,
                "name": entry.get("name") or tag,
                "departed": True,
            }
    roster = list(known.values())

    today = tu.app_today().isoformat()
    now_local = datetime.now(tu.app_tz())

    # A day is only *scored* once the next day's baseline exists. Every other
    # recorded day is an open window whose running total we can still show, so
    # both go in the picker - otherwise the day list is empty and unusable.
    recorded = {d["day"] for days in history.values() for d in days}
    open_days = recorded - set(day_totals)
    day_list = [
        {
            "day": day,
            "state": "open" if day in open_days else "scored",
            "donated": sum(day_totals[day].values()) if day in day_totals else None,
            "donors": (len([v for v in day_totals[day].values() if v > 0])
                       if day in day_totals else None),
        }
        for day in sorted(recorded, reverse=True)
    ]
    days = [item["day"] for item in day_list]
    if requested in days:
        selected = requested
    else:
        scored_days = [item["day"] for item in day_list if item["state"] == "scored"]
        selected = scored_days[0] if scored_days else (days[0] if days else None)

    selected_state = next(
        (item["state"] for item in day_list if item["day"] == selected), None
    )
    is_open = selected_state == "open"

    donors = []
    not_donated = []
    window = {}
    if selected:
        amounts = day_totals.get(selected, {})
        for member in roster:
            tag = member["tag"]
            row = next((d for d in history.get(tag, []) if d["day"] == selected), {})
            name = member.get("name") or by_member.get(tag, {}).get("name") or tag
            if is_open:
                # Window has not closed: report the running total so an in-day
                # number is available instead of an empty table.
                latest = row.get("latest")
                donated = 0
                reset = False
                if row and latest is not None:
                    donated = int(latest) - int(row.get("baseline") or 0)
                    if donated < 0:
                        donated, reset = 0, True
                window_from = row.get("captured_at")
                window_to = _iso_local(now_local)
                span_hours = _hours_since(window_from)
            else:
                donated = amounts.get(tag, 0)
                reset = bool(row.get("reset"))
                window_from = row.get("window_from")
                window_to = row.get("window_to")
                span_hours = row.get("span_hours")
            if donated > 0:
                donors.append({
                    "tag": tag,
                    "name": name,
                    "departed": bool(member.get("departed")),
                    "donated": donated,
                    "baseline": row.get("baseline"),
                    "window_from": window_from,
                    "window_to": window_to,
                    "span_hours": span_hours,
                    "reset": bool(reset),
                })
            else:
                not_donated.append({
                    "tag": tag,
                    "name": name,
                    "departed": bool(member.get("departed")),
                    "reset": bool(reset),
                })
        donors.sort(key=lambda item: -item["donated"])
        if is_open:
            window = {"from": window_from, "to": window_to, "span_hours": span_hours}
        else:
            first = next((d for d in donors if d.get("window_from")), None)
            if first:
                window = {
                    "from": first.get("window_from"),
                    "to": first.get("window_to"),
                    "span_hours": first.get("span_hours"),
                }

    today_so_far = []
    for member in roster:
        row = next(
            (d for d in history.get(member["tag"], []) if d["day"] == today), None
        )
        if not row:
            continue
        donated = row["latest"] - row["baseline"]
        today_so_far.append({
            "tag": member["tag"],
            "name": member.get("name") or row.get("name") or member["tag"],
            "donated": 0 if donated < 0 else donated,
            "reset": donated < 0,
            "baseline": row["baseline"],
            "latest": row["latest"],
            "latest_at": row.get("latest_at"),
        })
    today_so_far.sort(key=lambda item: -item["donated"])

    # One entry per recorded day, so the UI can show a running total for the
    # still-open day instead of only the settled ones.
    clan_daily = [
        {
            "day": item["day"],
            "state": item["state"],
            "donated": item["donated"] if item["state"] == "scored" else (
                sum(m["donated"] for m in donors) if item["day"] == selected
                and is_open else None
            ),
            "donors": item["donors"] if item["state"] == "scored" else (
                len(donors) if item["day"] == selected and is_open else None
            ),
        }
        for item in day_list
    ]

    # A baseline older than a day means the sync that should have captured the
    # next one never ran - surface that instead of an unexplained empty table.
    last_baseline = max(
        (row.get("latest_at") or row.get("captured_at")
         for days_ in history.values() for row in days_),
        default=None,
    )
    days_stale = None
    if last_baseline:
        # `last_baseline` is already a local ISO string from _contribution_days.
        age = _hours_since(last_baseline)
        if age is not None:
            days_stale = int(age // 24)

    return jsonify({
        "tz": tu.tz_info(),
        "today": today,
        "selected_day": selected,
        "selected_state": selected_state,
        "is_open": is_open,
        "days": days,
        "day_list": day_list,
        "window": window,
        "donors": donors,
        "not_donated": not_donated,
        "total_donated": sum(item["donated"] for item in donors),
        "donor_count": len(donors),
        "today_so_far": today_so_far,
        "today_total_so_far": sum(item["donated"] for item in today_so_far),
        "clan_daily": clan_daily,
        "history": history,
        "coverage": {
            "days_recorded": len(recorded),
            "days_scored": len(day_totals),
            "days_open": len(open_days),
            "members_recorded": len(history),
            "members_departed": len([m for m in roster if m.get("departed")]),
            "first_day": min(recorded) if recorded else None,
            "last_day": days[0] if days else None,
            "last_baseline_at": last_baseline,
            "days_stale": days_stale,
        },
    })


@app.route("/api/capital/leaderboard")
def api_capital_leaderboard():
    """Clan Capital loot, grouped per member across the tracked weekends."""
    raid_loot = _query_all(
        """
        SELECT COALESCE(MAX(m.name), MAX(cr.member_name)) AS member_name,
               cr.member_tag, SUM(cr.capital_gold) AS capital_gold,
               SUM(cr.attacks) AS attacks,
               SUM(cr.districts_destroyed) AS districts,
               COUNT(DISTINCT cr.raid_id) AS weekends
        FROM capital_raids cr
        LEFT JOIN members m ON m.tag = cr.member_tag
        GROUP BY cr.member_tag
        ORDER BY capital_gold DESC LIMIT 25
        """
    )
    totals = _query_all(
        """
        SELECT COUNT(DISTINCT cr.raid_id) AS weekends_with_data,
               SUM(cr.capital_gold) AS total_gold,
               COUNT(DISTINCT cr.member_tag) AS raiders
        FROM capital_raids cr
        """
    )
    weekend_total = _query_all("SELECT COUNT(*) AS c FROM raid_weekends")[0]["c"]
    coverage = dict(totals[0]) if totals else {}
    coverage["weekends_total"] = weekend_total
    coverage["note"] = (
        "Per-member raid detail is only available for recent raid weekends, so "
        "this totals the weekends the API still reports in full."
    )
    return jsonify({"raid_loot": raid_loot, "coverage": coverage})


@app.route("/api/wars/<int:war_id>/leaderboard")
def api_war_leaderboard(war_id):
    """Stars for one war - the number that matters when discussing a war."""
    war = _query_all("SELECT * FROM wars WHERE id = %s", (war_id,))
    if not war:
        return jsonify({"error": "War not found"}), 404
    stars = _query_all(
        """
        SELECT COALESCE(MAX(m.name), MAX(wa.attacker_name)) AS attacker_name,
               wa.attacker_tag, SUM(wa.stars) AS stars, COUNT(*) AS attacks,
               AVG(wa.destruction) AS avg_destruction
        FROM war_attacks wa
        LEFT JOIN members m ON m.tag = wa.attacker_tag
        WHERE wa.war_id = %s AND wa.side = %s
        GROUP BY wa.attacker_tag
        ORDER BY stars DESC
        """,
        (war_id, "clan" if request.args.get("side", "clan") != "enemy" else "enemy"),
    )
    counts = _query_all(
        "SELECT side, COUNT(*) AS n FROM war_attacks WHERE war_id = %s GROUP BY side",
        (war_id,),
    )
    return jsonify({
        "war": war[0], "stars": stars,
        "sides": {row["side"]: row["n"] for row in counts},
    })


@app.route("/api/inactivity")
def api_inactivity():
    """Inactivity report: who missed wars, raids or donations recently.

    Configurable via query parameters:
      ?wars=N      how many recent wars to check for missed attacks (default 5)
      ?raids=N     how many recent raid weekends to check (default 2)
      ?donation_days=N   scored donation days to check (default 7)
    Members still on the roster only — departed members are excluded.
    """
    wars_n = max(1, request.args.get("wars", default=5, type=int))
    raids_n = max(1, request.args.get("raids", default=2, type=int))
    donation_days = max(1, request.args.get("donation_days", default=7, type=int))

    try:
        return _inactivity_payload(wars_n, raids_n, donation_days)
    except Exception as exc:
        return jsonify({"error": f"Inactivity report unavailable: {exc}"}), 502


def _inactivity_payload(wars_n, raids_n, donation_days):
    roster = _query_all("SELECT tag, name, role FROM members ORDER BY name")
    by_tag = {m["tag"]: {"tag": m["tag"], "name": m["name"], "role": m.get("role")}
              for m in roster}

    # --- Wars: who used fewer attacks than the clan size allows -----------
    finished = _query_all(
        "SELECT * FROM wars WHERE result NOT IN ('preparation', 'inProgress') "
        "OR result IS NULL ORDER BY COALESCE(end_time, start_time) DESC LIMIT %s",
        (wars_n,),
    )
    war_rows = []
    for war in finished:
        attacks = _query_all(
            "SELECT attacker_tag, attacker_name, COUNT(*) AS used "
            "FROM war_attacks WHERE war_id = %s AND side = 'clan' "
            "GROUP BY attacker_tag, attacker_name",
            (war["id"],),
        )
        used = {a["attacker_tag"]: a["used"] for a in attacks}
        # In war each member gets 2 attacks (1 in CWL-style formats we cannot
        # detect from the warlog, so 2 is the honest default; a member with at
        # least one attack used is still flagged when they could have used more).
        expected = 2
        missed = []
        for tag, member in by_tag.items():
            u = used.get(tag, 0)
            if u < expected:
                missed.append({**member, "attacks_used": u,
                               "missed": expected - u})
        missed.sort(key=lambda x: (-x["missed"], x["name"]))
        war_rows.append({
            "war_id": war["id"],
            "opponent_name": war.get("opponent_name"),
            "start_time": _iso_local(war.get("start_time")),
            "end_time": _iso_local(war.get("end_time")),
            "result": war.get("result"),
            "is_cwl": bool(war.get("is_cwl")),
            "expected_attacks": expected,
            "missed": missed,
        })

    # --- Raid weekends: who did not attack --------------------------------
    raids = _query_all(
        "SELECT * FROM raid_weekends ORDER BY start_time DESC LIMIT %s", (raids_n,)
    )
    raid_rows = []
    for raid in raids:
        raiders = _query_all(
            "SELECT DISTINCT member_tag FROM capital_raids WHERE raid_id = %s",
            (raid["id"],),
        )
        attacked_tags = {r["member_tag"] for r in raiders}
        absent = [
            {**member, "capital_gold": 0}
            for tag, member in by_tag.items() if tag not in attacked_tags
        ]
        absent.sort(key=lambda x: x["name"])
        raid_rows.append({
            "raid_id": raid["id"],
            "start_time": _iso_local(raid.get("start_time")),
            "end_time": _iso_local(raid.get("end_time")),
            "missing": absent,
        })

    # --- Donations: no coins donated on a scored day -----------------------
    # Reuse the same day-scoring logic the donations tab uses, then flag each
    # roster member with zero donated coins across the most recent N scored
    # days (members with no baseline yet are reported separately).
    by_member, history, day_totals = _contribution_days()
    scored_days = sorted(day_totals.keys(), reverse=True)[:donation_days]
    donation_rows = []
    if scored_days:
        for tag, member in by_tag.items():
            days_in_history = history.get(tag, [])
            zero_days = [d for d in scored_days if day_totals[d].get(tag, 0) == 0]
            if not zero_days:
                continue
            donation_rows.append({
                **member,
                "no_donation_days": len(zero_days),
                "days_checked": len(scored_days),
                "last_donated": next(
                    (d["day"] for d in sorted(
                        (dd for dd in days_in_history
                         if dd.get("donated") and dd["donated"] > 0),
                        key=lambda x: x["day"], reverse=True
                    )),
                    None,
                ),
            })
        donation_rows.sort(
            key=lambda x: (-x["no_donation_days"], x["name"])
        )

    # --- Per-member rollup: flagged in each category -----------------------
    war_flag_counts = {}
    war_attack_deficit = {}
    for row in war_rows:
        for m in row["missed"]:
            war_flag_counts[m["tag"]] = war_flag_counts.get(m["tag"], 0) + 1
            war_attack_deficit[m["tag"]] = (
                war_attack_deficit.get(m["tag"], 0) + m["missed"]
            )
    raid_flag_counts = {}
    for row in raid_rows:
        for m in row["missing"]:
            raid_flag_counts[m["tag"]] = raid_flag_counts.get(m["tag"], 0) + 1

    rollup = []
    for tag, member in by_tag.items():
        war_flags = war_flag_counts.get(tag, 0)
        raid_flags = raid_flag_counts.get(tag, 0)
        donation = next(
            (d for d in donation_rows if d["tag"] == tag), None
        )
        donation_flags = donation["no_donation_days"] if donation else 0
        if not (war_flags or raid_flags or donation_flags):
            continue
        rollup.append({
            **member,
            "wars_missed": war_flags,
            "wars_checked": len(war_rows),
            "attacks_missed": war_attack_deficit.get(tag, 0),
            "raids_missed": raid_flags,
            "raids_checked": len(raid_rows),
            "no_donation_days": donation_flags,
            "donation_days_checked": len(scored_days),
        })
    # Severity: a point per missed war/raid weekend, and one per two days
    # without donations (donations are voluntary, war attacks are not).
    rollup.sort(
        key=lambda x: -(x["wars_missed"] + x["raids_missed"]
                        + x["no_donation_days"] / 2),
    )

    return jsonify({
        "params": {
            "wars": wars_n,
            "raids": raids_n,
            "donation_days": donation_days,
        },
        "members_checked": len(by_tag),
        "wars": war_rows,
        "raids": raid_rows,
        "donations": donation_rows,
        "donation_days_scored": scored_days,
        "rollup": rollup,
    })



@app.route("/api/sync", methods=["POST"])
def api_sync():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized. Send X-Admin-Key header."}), 401
    # A manual Sync refreshes every member's contributions immediately, so the
    # "so far today" figures are up to date instead of waiting for the cadence.
    ok, result = syncer.run_full_sync(force_contributions=True)
    runtime_state.record_sync(ok, result, source="manual")
    if not ok:
        return jsonify({"error": result}), 502
    return jsonify({"status": "ok", "synced": result})


@app.route("/api/cron-sync", methods=["GET", "POST"])
def api_cron_sync():
    """Scheduled sync for Vercel Cron (or manual use).

    Accepts either the admin key (X-Admin-Key) or Vercel's cron secret
    (Authorization: Bearer <CRON_SECRET>).
    """
    secret = os.environ.get("CRON_SECRET", "").strip()
    ok_cron = bool(secret) and request.headers.get(
        "Authorization", ""
    ) == f"Bearer {secret}"
    if not (_admin_ok() or ok_cron):
        return jsonify({"error": "Unauthorized"}), 401
    ok, result = syncer.run_full_sync()
    runtime_state.record_sync(ok, result, source="cron")
    if not ok:
        return jsonify({"error": result}), 502
    return jsonify({"status": "ok", "synced": result})


@app.route("/api/notes", methods=["POST"])
def api_notes():
    if not _admin_ok():
        return jsonify({"error": "Unauthorized. Send X-Admin-Key header."}), 401
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")
    item_id = data.get("id")
    notes = data.get("notes", "")
    if kind not in ("war", "raid") or not item_id:
        return jsonify({"error": "kind must be 'war' or 'raid', id required"}), 400
    table = "wars" if kind == "war" else "raid_weekends"
    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute(f"UPDATE {table} SET notes = %s WHERE id = %s", (notes, item_id))
    cur.close()
    conn.close()
    return jsonify({"status": "ok"})


@app.route("/api/diagnostics")
def api_diagnostics():
    """Setup report: API key + IP match, database, timezone, admin key.

    Use ?probe=0 to skip the live clan call and ?fresh=1 to bypass the cache.
    """
    probe = request.args.get("probe", "1") not in ("0", "false", "no")
    fresh = request.args.get("fresh", "0") in ("1", "true", "yes")
    report = diagnostics.collect(probe=probe, use_cache=not fresh)
    minutes = _auto_sync_minutes()
    report["autosync"] = {
        "enabled": (minutes > 0) and not os.environ.get("VERCEL"),
        "minutes": minutes,
        "last_attempt": runtime_state.last_sync(),
    }
    return jsonify(report)


@app.route("/api/admin/verify", methods=["POST"])
def api_admin_verify():
    """Let the UI check a key before saving it, and learn about local trust."""
    payload = {"admin": _admin_ok(), "local_trusted": _local_sync_allowed()}
    return jsonify(payload), (200 if payload["admin"] else 401)


_auto_sync_started = False
_auto_sync_lock = threading.Lock()
AUTO_SYNC_DEFAULT_MINUTES = 30


def _auto_sync_minutes():
    """Configured auto-sync interval in minutes (0 disables syncing)."""
    raw = os.environ.get("AUTO_SYNC_MINUTES")
    if raw is None or str(raw).strip() == "":
        return AUTO_SYNC_DEFAULT_MINUTES
    try:
        return max(0, int(str(raw).strip()))
    except ValueError:
        return AUTO_SYNC_DEFAULT_MINUTES


def _maybe_refresh_key(result):
    """Self-heal a stale IP whitelist after a 403, when AUTO_REFRESH_KEY=1.

    Off by default: it needs COC_DEV_EMAIL / COC_DEV_PASSWORD in the environment.
    The Task Scheduler route (scripts/refresh_key.cmd) does the same job without
    the web app spawning processes.
    """
    raw = str(os.environ.get("AUTO_REFRESH_KEY", "0")).strip().lower()
    if raw not in ("1", "true", "yes", "on"):
        return False
    if "403" not in str(result):
        return False
    script = os.path.join(BASE_DIR, "scripts", "refresh_key.py")
    if not os.path.exists(script):
        return False
    try:
        proc = subprocess.run(
            [sys.executable, script, "--quiet"],
            cwd=BASE_DIR, capture_output=True, timeout=180,
        )
    except Exception as exc:  # a failed refresh must never kill the loop
        app.logger.warning("Key refresh could not run: %s", exc)
        return False
    detail = (proc.stdout or proc.stderr or b"").decode("utf-8", "replace").strip()
    app.logger.info("Key refresh exited %s: %s", proc.returncode, detail[:400])
    return proc.returncode == 0


def _auto_sync_loop(minutes):
    """Background loop: sync once shortly after boot, then every N minutes."""
    import time

    time.sleep(5)
    while True:
        try:
            ok, result = syncer.run_full_sync()
            runtime_state.record_sync(ok, result, source="auto")
            if not ok and _maybe_refresh_key(result):
                # The key was stale: retry once with the fresh token.
                ok, result = syncer.run_full_sync()
                runtime_state.record_sync(ok, result, source="auto-after-refresh")
            app.logger.info("Auto-sync %s: %s", "ok" if ok else "failed", result)
        except Exception as exc:  # never kill the loop
            app.logger.warning("Auto-sync failed: %s", exc)
            runtime_state.record_sync(False, exc, source="auto")
        time.sleep(minutes * 60)


def _maybe_start_auto_sync():
    """Start the background auto-sync thread (local only, serving process only).

    Started lazily on the first request instead of at import time: Werkzeug's
    debug reloader imports this module in both the parent and the child, and
    only the process that actually serves requests should own the thread.
    On Vercel the thread is skipped entirely — `vercel.json` uses a Cron job.
    """
    global _auto_sync_started
    if _auto_sync_started:
        return
    if os.environ.get("VERCEL"):
        return
    minutes = _auto_sync_minutes()
    if minutes <= 0:
        return
    with _auto_sync_lock:
        if _auto_sync_started:
            return
        _auto_sync_started = True
    thread = threading.Thread(
        target=_auto_sync_loop, args=(minutes,), daemon=True, name="coc-auto-sync"
    )
    thread.start()
    app.logger.info("Auto-sync enabled: every %s minute(s)", minutes)
    key_state = diagnostics.admin_key_status()
    if key_state["weak"]:
        app.logger.warning(
            "ADMIN_KEY looks weak (%s chars). %s", key_state["length"], key_state["hint"]
        )


@app.before_request
def _auto_sync_boot():
    _maybe_start_auto_sync()


if __name__ == "__main__":
    app.run(
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "5000")),
        debug=True,
    )
