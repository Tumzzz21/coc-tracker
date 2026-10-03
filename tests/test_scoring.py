# DB-backed test of the daily contribution math behind /api/contributions.
#
# Ported from scripts/check_scoring.py: inserts synthetic baseline rows for two
# past days, asserts the delta/window behaviour through the Flask test client,
# then deletes exactly the rows it created. Skipped when MySQL is unreachable
# (or set SKIP_DB_TESTS=1).
from datetime import datetime, timedelta, timezone

import pytest

from tests.conftest import requires_db

from config import db, timeutil as tu

import app as flask_app


@pytest.fixture(scope="module")
def client():
    return flask_app.app.test_client()


TAG_A = "#TESTSYNA"
TAG_B = "#TESTSYNB"


@pytest.fixture
def synthetic_days():
    """Two fake members x two days of baselines, cleaned up afterwards.

    Dedicated #TEST tags, never real roster members: reusing a real tag would
    collide with its recorded days (the fixture skips existing rows, which
    silently breaks the baseline-delta math under test).
    """
    day_a = tu.app_today() - timedelta(days=2)
    day_b = tu.app_today() - timedelta(days=1)
    base_a, base_b = 1_900_000, 2_000_000
    captured_a = datetime.combine(
        day_a - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc
    ).replace(hour=16, minute=2)
    captured_b = datetime.combine(
        day_b - timedelta(days=1), datetime.min.time(), tzinfo=timezone.utc
    ).replace(hour=16, minute=3)

    planned = [
        # Member A donates 100k on day_a (baseline rises between the days).
        (TAG_A, day_a, base_a, captured_a),
        (TAG_A, day_b, base_b, captured_b),
        # Member B's counter FALLS between the days: the app must flag a
        # reset/rejoin instead of reporting a negative amount.
        (TAG_B, day_a, base_b + 500, captured_a),
        (TAG_B, day_b, base_a - 100, captured_b),
    ]
    conn = db.get_connection()
    cur = db.cursor(conn)
    inserted = []
    for tag, day, total, captured in planned:
        cur.execute(
            "SELECT 1 FROM member_contributions WHERE member_tag = %s AND day = %s",
            (tag, day),
        )
        if cur.fetchone():
            continue  # leftovers from an interrupted run - leave them
        cur.execute(
            """INSERT INTO member_contributions (member_tag, day, total_contributions,
                   latest_contributions, member_name, captured_at, latest_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (tag, day, total, total, "Test Member", captured, captured),
        )
        inserted.append((tag, day))
    conn.commit()
    cur.close()
    conn.close()

    yield {
        "day_a": day_a, "tag_a": TAG_A, "tag_b": TAG_B,
        "base_a": base_a, "base_b": base_b,
        "ready_b": (TAG_B, day_a) in inserted and (TAG_B, day_b) in inserted,
    }

    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute("DELETE FROM member_contributions WHERE member_tag IN (%s, %s)",
                (TAG_A, TAG_B))
    conn.commit()
    cur.close()
    conn.close()


@requires_db
def test_day_delta_is_baseline_difference(client, synthetic_days):
    d = synthetic_days
    response = client.get(f"/api/contributions?day={d['day_a'].isoformat()}")
    payload = response.get_json() or {}
    donors = {x["tag"]: x["donated"] for x in payload.get("donors", [])}
    assert donors.get(d["tag_a"]) == d["base_b"] - d["base_a"]


@requires_db
def test_day_appears_in_reported_days(client, synthetic_days):
    d = synthetic_days
    response = client.get(f"/api/contributions?day={d['day_a'].isoformat()}")
    payload = response.get_json() or {}
    assert d["day_a"].isoformat() in (payload.get("days") or [])


@requires_db
def test_measured_window_is_reported(client, synthetic_days):
    d = synthetic_days
    response = client.get(f"/api/contributions?day={d['day_a'].isoformat()}")
    payload = response.get_json() or {}
    window = payload.get("window") or {}
    assert window.get("from") and window.get("span_hours")


@requires_db
def test_falling_counter_flagged_as_reset_not_negative(client, synthetic_days):
    d = synthetic_days
    response = client.get(f"/api/contributions?day={d['day_a'].isoformat()}")
    payload = response.get_json() or {}
    flagged = any(
        m["tag"] == d["tag_b"] and m.get("reset")
        for m in payload.get("not_donated", [])
    )
    assert flagged
