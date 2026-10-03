# Syncs data from the official CoC API into the configured database.
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import coc_api
from config import db, timeutil as tu


def _parse_ts(value):
    """CoC API timestamps look like '20240901T123456.000Z'."""
    if not value:
        return None
    try:
        return datetime.strptime(value.split(".")[0], "%Y%m%dT%H%M%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def _war_key(end_time_iso, opponent_tag):
    """Canonical, stable key for a war.

    `endTime` is the only timestamp the API returns for *both* the live war
    (currentwar) and finished wars (warlog), so keying on it makes the two
    sync paths idempotent: a war tracked live is simply updated by the warlog
    sync afterwards, never inserted twice.
    """
    return f"war-{end_time_iso or ''}-{opponent_tag or ''}"


def _plausible_war(war):
    """True when a warlog entry carries the fields a wars row needs.

    Guards against junk rows like the one that once stored
    ``external_key='war-20260910T041447.000Z-'`` (no opponent, stars_for=694):
    without an opponent identity the key degenerates to the bare timestamp, and
    a star count above teamSize * 3 (max per member) cannot be real. Such rows
    sorted first on every stars/destruction leaderboard until deleted by hand.
    """
    opponent = war.get("opponent") or {}
    if not opponent.get("tag"):
        return False
    clan = war.get("clan") or {}
    team_size = war.get("teamSize") or 0
    max_stars = team_size * 3 if team_size else None
    for block in (clan, opponent):
        stars = block.get("stars")
        if max_stars and isinstance(stars, (int, float)) and stars > max_stars:
            return False
    return True


def _log(endpoint, items, status="ok", error=None):
    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute(
        "INSERT INTO sync_log (endpoint, items_fetched, status, error) VALUES (%s, %s, %s, %s)",
        (endpoint, items, status, error),
    )
    cur.close()
    conn.close()


def _upsert_sql(mysql_sql, postgres_sql):
    return mysql_sql if not db.is_postgres() else postgres_sql


def _ensure_attack_side_column(cur):
    """Make sure war_attacks.side exists (one-time migration for old DBs).

    'clan' = attack made by one of our members, 'enemy' = made against us.
    Existing rows default to 'enemy' and are backfilled from the members
    roster right after the column is added.
    """
    if db.is_postgres():
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name='war_attacks' AND column_name='side'"
        )
    else:
        cur.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_schema = DATABASE() AND table_name='war_attacks' "
            "AND column_name='side'"
        )
    if cur.fetchone():
        return
    cur.execute("ALTER TABLE war_attacks ADD COLUMN side VARCHAR(8) DEFAULT 'enemy'")
    cur.execute(
        """
        UPDATE war_attacks wa
        JOIN members m ON m.tag = wa.attacker_tag
        SET wa.side = 'clan'
        """
        if not db.is_postgres()
        else """
        UPDATE war_attacks wa SET side = 'clan'
        FROM members m WHERE m.tag = wa.attacker_tag
        """
    )
    _log("migration", 0, status="ok", error="war_attacks.side added + backfilled")


def ensure_schema_migrations():
    """Run one-time schema migrations on the active database (idempotent)."""
    conn = db.get_connection()
    cur = db.cursor(conn)
    try:
        _ensure_attack_side_column(cur)
    finally:
        cur.close()
        conn.close()


def sync_members():
    members = coc_api.get_members()
    conn = db.get_connection()
    cur = db.cursor(conn)
    for member in members:
        cur.execute(
            _upsert_sql(
                """
                INSERT INTO members (tag, name, role, town_hall, trophies, last_seen)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON DUPLICATE KEY UPDATE
                  name=VALUES(name), role=VALUES(role), town_hall=VALUES(town_hall),
                  trophies=VALUES(trophies), last_seen=NOW()
                """,
                """
                INSERT INTO members (tag, name, role, town_hall, trophies, last_seen)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (tag) DO UPDATE SET
                  name=EXCLUDED.name, role=EXCLUDED.role, town_hall=EXCLUDED.town_hall,
                  trophies=EXCLUDED.trophies, last_seen=NOW()
                """,
            ),
            (
                member.get("tag"),
                member.get("name"),
                member.get("role"),
                member.get("townHallLevel"),
                member.get("trophies"),
            ),
        )
    # Drop members no longer in the clan so the roster matches the live clan
    # (upserts alone leave departed players behind forever). Contribution and
    # raid history is keyed by tag in other tables and is deliberately kept.
    if members:
        placeholders = ",".join(["%s"] * len(members))
        cur.execute(
            f"DELETE FROM members WHERE tag NOT IN ({placeholders})",
            [m.get("tag") for m in members],
        )
    cur.close()
    conn.close()
    _log("members", len(members))
    return len(members)


def sync_wars():
    wars = coc_api.get_warlog()
    conn = db.get_connection()
    cur = db.cursor(conn)
    count = 0
    skipped = 0
    for war in wars:
        if not _plausible_war(war):
            skipped += 1
            _log("warlog", 0, status="skipped",
                 error="implausible warlog entry (no opponent tag or star count over the cap)")
            continue
        result = war.get("result") or ("inWar" if war.get("state") == "inWar" else None)
        clan_block = war.get("clan") or {}
        opponent_block = war.get("opponent") or {}
        end = _parse_ts(war.get("endTime"))
        # The official warlog exposes only `endTime` (no start time, no attack
        # details), so the key is built from it — see `_war_key`.
        start = _parse_ts(war.get("startTime"))
        key = _war_key(war.get("endTime"), opponent_block.get("tag"))

        # Older versions stored live wars under a 'current-...' key. If such a
        # row exists for this war, fold it into the canonical key instead of
        # inserting a duplicate (moving its recorded attacks with it).
        adopted = None
        if end:
            cur.execute(
                "SELECT id FROM wars WHERE external_key LIKE %s AND end_time = %s",
                ("current-%", end),
            )
            adopted = cur.fetchone()
        if adopted:
            cur.execute("SELECT id FROM wars WHERE external_key = %s", (key,))
            canonical = cur.fetchone()
            if canonical and canonical["id"] != adopted["id"]:
                cur.execute(
                    "UPDATE war_attacks SET war_id = %s WHERE war_id = %s",
                    (canonical["id"], adopted["id"]),
                )
                cur.execute("DELETE FROM wars WHERE id = %s", (adopted["id"],))
            else:
                cur.execute(
                    "UPDATE wars SET external_key = %s WHERE id = %s",
                    (key, adopted["id"]),
                )

        cur.execute(
            _upsert_sql(
                """
                INSERT INTO wars (external_key, opponent_name, opponent_tag, team_size,
                    start_time, end_time, result, stars_for, stars_against,
                    destruction_for, destruction_against, is_cwl)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  result=VALUES(result), stars_for=VALUES(stars_for),
                  stars_against=VALUES(stars_against),
                  destruction_for=VALUES(destruction_for),
                  destruction_against=VALUES(destruction_against)
                """,
                """
                INSERT INTO wars (external_key, opponent_name, opponent_tag, team_size,
                    start_time, end_time, result, stars_for, stars_against,
                    destruction_for, destruction_against, is_cwl)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (external_key) DO UPDATE SET
                  result=EXCLUDED.result, stars_for=EXCLUDED.stars_for,
                  stars_against=EXCLUDED.stars_against,
                  destruction_for=EXCLUDED.destruction_for,
                  destruction_against=EXCLUDED.destruction_against
                """,
            ),
            (
                key,
                opponent_block.get("name"),
                opponent_block.get("tag"),
                war.get("teamSize"),
                start,
                end,
                result,
                clan_block.get("stars", 0),
                opponent_block.get("stars", 0),
                clan_block.get("destructionPercentage", 0),
                opponent_block.get("destructionPercentage", 0),
                war.get("type") == "cwl",
            ),
        )
        count += 1
    cur.close()
    conn.close()
    _log("warlog", count)
    return count, skipped


def sync_capital():
    seasons = coc_api.get_capital_raidseasons()
    conn = db.get_connection()
    cur = db.cursor(conn)
    count = 0
    for season in seasons:
        start = _parse_ts(season.get("startTime"))
        end = _parse_ts(season.get("endTime"))
        key = f"raid-{season.get('startTime', '')}"
        members = season.get("members", [])

        cur.execute(
            _upsert_sql(
                """
                INSERT INTO raid_weekends (external_key, start_time, end_time,
                    raids_completed, total_capital_gold, total_raid_medals,
                    total_attacks, districts_destroyed)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON DUPLICATE KEY UPDATE
                  raids_completed=VALUES(raids_completed),
                  total_capital_gold=VALUES(total_capital_gold),
                  total_raid_medals=VALUES(total_raid_medals),
                  total_attacks=VALUES(total_attacks),
                  districts_destroyed=VALUES(districts_destroyed)
                """,
                """
                INSERT INTO raid_weekends (external_key, start_time, end_time,
                    raids_completed, total_capital_gold, total_raid_medals,
                    total_attacks, districts_destroyed)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (external_key) DO UPDATE SET
                  raids_completed=EXCLUDED.raids_completed,
                  total_capital_gold=EXCLUDED.total_capital_gold,
                  total_raid_medals=EXCLUDED.total_raid_medals,
                  total_attacks=EXCLUDED.total_attacks,
                  districts_destroyed=EXCLUDED.districts_destroyed
                """,
            ),
            (
                key,
                start,
                end,
                len(members),
                sum(m.get("capitalResourcesLooted", 0) for m in members),
                0,
                sum(m.get("attacks", 0) for m in members),
                sum(m.get("districtsDestroyed", 0) for m in members),
            ),
        )

        cur.execute("SELECT id FROM raid_weekends WHERE external_key = %s", (key,))
        row = cur.fetchone()
        if not row:
            continue
        raid_id = row["id"]

        for member in members:
            cur.execute(
                _upsert_sql(
                    """
                    INSERT INTO capital_raids (raid_id, member_tag, member_name,
                        hall_level, attacks, capital_gold, raid_medals,
                        districts_destroyed)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                      member_name=VALUES(member_name), hall_level=VALUES(hall_level),
                      attacks=VALUES(attacks), capital_gold=VALUES(capital_gold),
                      districts_destroyed=VALUES(districts_destroyed)
                    """,
                    """
                    INSERT INTO capital_raids (raid_id, member_tag, member_name,
                        hall_level, attacks, capital_gold, raid_medals,
                        districts_destroyed)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (raid_id, member_tag) DO UPDATE SET
                      member_name=EXCLUDED.member_name, hall_level=EXCLUDED.hall_level,
                      attacks=EXCLUDED.attacks, capital_gold=EXCLUDED.capital_gold,
                      districts_destroyed=EXCLUDED.districts_destroyed
                    """,
                ),
                (
                    raid_id,
                    member.get("tag"),
                    member.get("name"),
                    member.get("capitalHallLevel"),
                    member.get("attacks"),
                    member.get("capitalResourcesLooted", 0),
                    0,
                    member.get("districtsDestroyed", 0),
                ),
            )
        count += 1
    cur.close()
    conn.close()
    _log("capitalraidseasons", count)
    return count


def _prune_sync_log(keep_days=30):
    """Delete sync_log rows older than `keep_days` (the UI reads the last 20).

    The log grows on every sync (auto-sync fires up to 48x/day); without this
    it grows forever while only ever being read as "recent".
    """
    conn = db.get_connection()
    cur = db.cursor(conn)
    try:
        if db._is_postgres():
            cur.execute(
                "DELETE FROM sync_log WHERE created_at < NOW() - INTERVAL '%s days'",
                (keep_days,),
            )
        else:
            cur.execute(
                "DELETE FROM sync_log WHERE created_at < NOW() - INTERVAL %s DAY",
                (keep_days,),
            )
        deleted = cur.rowcount
        conn.commit()
        return deleted
    finally:
        cur.close()
        conn.close()


def run_full_sync(force_contributions=False):
    """Returns (ok, summary dict or error string)."""
    summary = {}
    try:
        ensure_schema_migrations()
        summary["members"] = sync_members()
        wars_synced, wars_skipped = sync_wars()
        summary["wars"] = wars_synced
        if wars_skipped:
            summary["wars_skipped"] = wars_skipped
        summary["current_war"] = sync_current_war()
        summary["raid_weekends"] = sync_capital()
        summary["contributions"] = snapshot_contributions(force=force_contributions)
        summary["sync_log_pruned"] = _prune_sync_log()
        return True, summary
    except Exception as exc:
        _log("full", 0, status="error", error=str(exc)[:500])
        return False, str(exc)


def sync_current_war():
    """Track the war happening right now (preparation or inWar)."""
    war = coc_api.get_current_war()
    state = war.get("state")
    if not state or state == "notInWar":
        _log("currentwar", 0, status="ok", error="notInWar")
        return 0

    clan_block = war.get("clan") or {}
    opponent_block = war.get("opponent") or {}
    key = _war_key(
        war.get("endTime") or war.get("preparationStartTime"),
        opponent_block.get("tag"),
    )
    start = _parse_ts(war.get("startTime") or war.get("preparationStartTime"))
    end = _parse_ts(war.get("endTime"))

    if state == "warEnded":
        result = war.get("result") or "ended"
    elif state == "inWar":
        result = "inProgress"
    else:
        result = "preparation"

    # The warlog and currentwar endpoints can report endTime up to a couple of
    # seconds apart, which would produce two rows for the same war (one from
    # each sync path) instead of the intended single canonical key. Adopt an
    # existing near-identical row by re-keying it before the upsert.
    conn = db.get_connection()
    cur = db.cursor(conn)
    if end:
        cur.execute(
            "SELECT id, external_key FROM wars WHERE opponent_tag = %s "
            "AND end_time BETWEEN %s AND %s AND external_key <> %s",
            (opponent_block.get("tag"), end - timedelta(seconds=10),
             end + timedelta(seconds=10), key),
        )
        near = cur.fetchone()
        if near:
            cur.execute("SELECT id FROM wars WHERE external_key = %s", (key,))
            existing = cur.fetchone()
            if existing and existing["id"] != near["id"]:
                # The canonical key is already taken by the warlog's copy of
                # this war: fold the near-duplicate into it, moving attacks.
                cur.execute(
                    "UPDATE war_attacks SET war_id = %s WHERE war_id = %s",
                    (existing["id"], near["id"]),
                )
                cur.execute("DELETE FROM wars WHERE id = %s", (near["id"],))
            else:
                cur.execute(
                    "UPDATE wars SET external_key = %s WHERE id = %s",
                    (key, near["id"]),
                )

    cur.execute(
        _upsert_sql(
            """
            INSERT INTO wars (external_key, opponent_name, opponent_tag, team_size,
                start_time, end_time, result, stars_for, stars_against,
                destruction_for, destruction_against, is_cwl)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON DUPLICATE KEY UPDATE
              result=VALUES(result), stars_for=VALUES(stars_for),
              stars_against=VALUES(stars_against),
              destruction_for=VALUES(destruction_for),
              destruction_against=VALUES(destruction_against),
              end_time=VALUES(end_time)
            """,
            """
            INSERT INTO wars (external_key, opponent_name, opponent_tag, team_size,
                start_time, end_time, result, stars_for, stars_against,
                destruction_for, destruction_against, is_cwl)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (external_key) DO UPDATE SET
              result=EXCLUDED.result, stars_for=EXCLUDED.stars_for,
              stars_against=EXCLUDED.stars_against,
              destruction_for=EXCLUDED.destruction_for,
              destruction_against=EXCLUDED.destruction_against,
              end_time=EXCLUDED.end_time
            """,
        ),
        (
            key,
            opponent_block.get("name"),
            opponent_block.get("tag"),
            war.get("teamSize"),
            start,
            end,
            result,
            clan_block.get("stars", 0),
            opponent_block.get("stars", 0),
            clan_block.get("destructionPercentage", 0),
            opponent_block.get("destructionPercentage", 0),
            war.get("type") == "cwl",
        ),
    )
    cur.execute("SELECT id FROM wars WHERE external_key = %s", (key,))
    row = cur.fetchone()
    if not row:
        cur.close()
        conn.close()
        return 0
    war_id = row["id"]

    # Resolve attacker/defender tags to names from both team lists.
    names = {}
    for block in (clan_block, opponent_block):
        for member in block.get("members", []):
            if member.get("tag"):
                names[member["tag"]] = member.get("name")

    # Live attacks are refreshed on every sync (not appended). Individual
    # attacks are nested per member (`clan.members[].attacks[]`); the clan-level
    # `attacks` field is just an integer count, so it must not be iterated.
    # Each attack is tagged with the side that made it ('clan'/'enemy') so the
    # UI and leaderboards can separate our members from the opponent.
    _ensure_attack_side_column(cur)
    cur.execute("DELETE FROM war_attacks WHERE war_id = %s", (war_id,))
    total = 0
    for side, block in (("clan", clan_block), ("enemy", opponent_block)):
        for member in block.get("members") or []:
            for attack in member.get("attacks") or []:
                cur.execute(
                    """
                    INSERT INTO war_attacks (war_id, attacker_tag, attacker_name,
                        defender_tag, defender_name, stars, destruction, `order`, duration, side)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """
                    if not db.is_postgres()
                    else """
                    INSERT INTO war_attacks (war_id, attacker_tag, attacker_name,
                        defender_tag, defender_name, stars, destruction, "order", duration, side)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    """,
                    (
                        war_id,
                        attack.get("attackerTag"),
                        names.get(attack.get("attackerTag")),
                        attack.get("defenderTag"),
                        names.get(attack.get("defenderTag")),
                        attack.get("stars"),
                        attack.get("destructionPercentage"),
                        attack.get("order"),
                        attack.get("duration"),
                        side,
                    ),
                )
                total += 1
    cur.close()
    conn.close()
    _log("currentwar", total)
    return total


def _as_utc(value):
    """Normalise MySQL (naive) / Postgres (aware) timestamps to aware UTC."""
    if not isinstance(value, datetime):
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _fetch_player_contribution(tag):
    """One API call for one member's lifetime capital gold contributed."""
    try:
        player = coc_api.get_player(tag)
        return tag, int(player.get("clanCapitalContributions") or 0), None
    except Exception as exc:  # a single failure must not abort the snapshot
        return tag, None, str(exc)[:160]


def snapshot_contributions(force=False):
    """Record capital-coin contributions for the current local day.

    `clanCapitalContributions` is a LIFETIME total and is only exposed on the
    player endpoint, so this costs one API call per member (the clan endpoints
    do not return it at all).

    Two numbers are kept per member per local day:

    * ``total_contributions`` — the **first** reading of that day (the
      baseline). Donated during day D = baseline(D) - baseline(D-1), which is
      an exact ~24h window in the app timezone.
    * ``latest_contributions`` — the most recent reading ("so far today").

    Members already baselined today are not re-fetched, so a partial or
    rate-limited run simply finishes on the next sync instead of repeating all
    calls. ``latest`` is refreshed every ``CONTRIB_SNAPSHOT_HOURS`` hours
    (default 6; set 0 for the cheapest once-a-day mode). ``force=True`` (the
    manual Sync button) refreshes every member immediately.
    """
    today = tu.app_today()
    cadence = tu.contrib_snapshot_hours()

    conn = db.get_connection()
    cur = db.cursor(conn)
    cur.execute("SELECT tag, name FROM members")
    roster = [dict(row) for row in cur.fetchall()]
    if not roster:
        cur.close()
        conn.close()
        _log("contributions", 0, status="ok", error="no roster synced yet")
        return 0

    cur.execute(
        "SELECT member_tag, captured_at, latest_at FROM member_contributions WHERE day = %s",
        (today,),
    )
    recorded_today = {row["member_tag"]: dict(row) for row in cur.fetchall()}

    cutoff = datetime.now(timezone.utc) - timedelta(hours=cadence) if cadence else None
    targets = []  # (tag, is_baseline)
    for member in roster:
        tag = member["tag"]
        row = recorded_today.get(tag)
        if row is None:
            targets.append((tag, True))
            continue
        if force:
            targets.append((tag, False))
            continue
        if cutoff is not None:
            last = _as_utc(row.get("latest_at")) or _as_utc(row.get("captured_at"))
            if last is None or last <= cutoff:
                targets.append((tag, False))

    if not targets:
        cur.close()
        conn.close()
        _log(
            "contributions",
            0,
            status="ok",
            error=f"already recorded for {today.isoformat()}",
        )
        return 0

    tags = [tag for tag, _ in targets]
    results = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for tag, value, error in pool.map(_fetch_player_contribution, tags):
            results[tag] = (value, error)

    names = {member["tag"]: member.get("name") for member in roster}
    now_utc = datetime.now(timezone.utc)
    written = 0
    failures = []
    for tag, is_baseline in targets:
        value, error = results.get(tag, (None, "no result"))
        if value is None:
            failures.append(f"{tag}: {error}")
            continue
        if is_baseline:
            # First reading of the day: store it as the day's baseline. The
            # baseline must never be overwritten by a later reading, so the
            # conflict clause only touches the "latest" columns.
            cur.execute(
                _upsert_sql(
                    """
                    INSERT INTO member_contributions (member_tag, day, total_contributions,
                        latest_contributions, member_name, captured_at, latest_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                      latest_contributions=VALUES(latest_contributions),
                      latest_at=VALUES(latest_at),
                      member_name=VALUES(member_name)
                    """,
                    """
                    INSERT INTO member_contributions (member_tag, day, total_contributions,
                        latest_contributions, member_name, captured_at, latest_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (member_tag, day) DO UPDATE SET
                      latest_contributions=EXCLUDED.latest_contributions,
                      latest_at=EXCLUDED.latest_at,
                      member_name=EXCLUDED.member_name
                    """,
                ),
                (tag, today, value, value, names.get(tag), now_utc, now_utc),
            )
        else:
            cur.execute(
                "UPDATE member_contributions SET latest_contributions = %s, latest_at = %s,"
                " member_name = %s WHERE member_tag = %s AND day = %s",
                (value, now_utc, names.get(tag), tag, today),
            )
        written += 1
    cur.close()
    conn.close()
    _log(
        "contributions",
        written,
        status="ok" if not failures else "warn",
        error="; ".join(failures[:3]) if failures else None,
    )
    return written
