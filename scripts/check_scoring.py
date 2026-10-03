"""Check the daily-scoring math against the real /api/contributions output.

    python scripts/check_scoring.py

Inserts synthetic rows for two days in the *recent past* on behalf of existing
members, asserts the delta/window/reset behaviour, then deletes exactly the rows
it created - it never touches recorded days or the current day. Days are scored
from two consecutive daily baselines, so a day is only final once the next day's
baseline exists; that is what these synthetic rows set up.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

import app as flask_app  # noqa: E402
from config import db, timeutil as tu  # noqa: E402

DAY_A = tu.app_today() - timedelta(days=2)
DAY_B = tu.app_today() - timedelta(days=1)
BASE_A = 1_900_000
BASE_B = 2_000_000
# 16:0x UTC == 00:0x the next day in PH, i.e. just after the day boundary.
CAPTURED_A = datetime.combine(DAY_A - timedelta(days=1), datetime.min.time(),
                              tzinfo=timezone.utc).replace(hour=16, minute=2)
CAPTURED_B = datetime.combine(DAY_B - timedelta(days=1), datetime.min.time(),
                              tzinfo=timezone.utc).replace(hour=16, minute=3)


def main():
    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute(
        "SELECT member_tag, member_name FROM member_contributions"
        " GROUP BY member_tag, member_name ORDER BY COUNT(*) DESC LIMIT 2"
    )
    members = [dict(row) for row in cur.fetchall()]
    if not members:
        print("No members have contribution history yet - run a sync first.")
        cur.close()
        conn.close()
        return 1

    member_a = members[0]
    member_b = members[-1]  # with a single member, A and B are the same tag
    print(f"member A: {member_a['member_name']} ({member_a['member_tag']})")
    print(f"member B: {member_b['member_name']} ({member_b['member_tag']})")

    same_member = member_b["member_tag"] == member_a["member_tag"]
    # B's counter drops between the two days => the app must flag a reset/rejoin
    # instead of reporting a negative amount. That needs both baselines, so B
    # only participates when there is a second distinct member.
    planned = [
        (member_a["member_tag"], DAY_A, BASE_A, CAPTURED_A),
        (member_a["member_tag"], DAY_B, BASE_B, CAPTURED_B),
    ]
    if not same_member:
        planned += [
            (member_b["member_tag"], DAY_A, BASE_B + 500, CAPTURED_A),
            (member_b["member_tag"], DAY_B, BASE_A - 100, CAPTURED_B),
        ]
    inserted = []
    for tag, day, total, captured in planned:
        cur.execute(
            "SELECT 1 FROM member_contributions WHERE member_tag = %s AND day = %s",
            (tag, day),
        )
        if cur.fetchone():
            print(f"  skip {tag} {day}: a real row already exists")
            continue
        cur.execute(
            """INSERT INTO member_contributions (member_tag, day, total_contributions,
                   latest_contributions, member_name, captured_at, latest_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (tag, day, total, total, None, captured, captured),
        )
        inserted.append((tag, day))
    print(f"inserted {len(inserted)} synthetic rows (removed again at the end)")
    b_pair_ready = not same_member and all(
        (member_b["member_tag"], day) in inserted for day in (DAY_A, DAY_B)
    )

    client = flask_app.app.test_client()
    checks = []
    try:
        response = client.get(f"/api/contributions?day={DAY_A.isoformat()}")
        payload = response.get_json() or {}
        print("\nGET /api/contributions?day=%s -> %s" % (DAY_A, response.status_code))
        print("  days:", payload.get("days"))
        print("  window:", payload.get("window"))
        print("  donors:", [(d["name"], d["donated"]) for d in payload.get("donors", [])])
        reset = [m["name"] for m in payload.get("not_donated", []) if m.get("reset")]
        print("  reset flagged:", reset)

        donors = {d["tag"]: d["donated"] for d in payload.get("donors", [])}
        checks = [
            (f"day {DAY_A} appears in the report",
             DAY_A.isoformat() in (payload.get("days") or [])),
            (f"member A donated {BASE_B - BASE_A} that day",
             donors.get(member_a["member_tag"]) == BASE_B - BASE_A),
            ("a measured window with hours is reported",
             bool(payload.get("window", {}).get("from")) and bool(payload.get("window", {}).get("span_hours"))),
        ]
        if same_member:
            print("\n(reset check skipped: only one member has contribution history)")
        elif b_pair_ready:
            checks.append((
                "member B's falling counter is flagged, not counted as negative",
                any(m["tag"] == member_b["member_tag"] and m.get("reset")
                    for m in payload.get("not_donated", [])),
            ))
        else:
            print("\n(reset check skipped: a real row already covers B's two days)")
    finally:
        for tag, day in inserted:
            cur.execute(
                "DELETE FROM member_contributions WHERE member_tag = %s AND day = %s",
                (tag, day),
            )
        cur.execute("SELECT COUNT(*) AS rows_left FROM member_contributions")
        print("\ncleanup: removed %s synthetic rows; %s rows remain"
              % (len(inserted), dict(cur.fetchone())["rows_left"]))
        cur.close()
        conn.close()

    print("\n=== assertions ===")
    failed = 0
    for label, ok in checks:
        print(("PASS  " if ok else "FAIL  ") + label)
        failed += 0 if ok else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
