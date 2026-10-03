# Timezone helpers shared by the sync job and the web layer.
#
# "Days" (capital coin contribution records) are bucketed by the *server's*
# local time so the user's real day boundary is what gets recorded.
#
# Resolution order:
#   1. APP_UTC_OFFSET  explicit fixed offset, e.g. "+08:00" (works everywhere)
#   2. server local time (on Vercel set TZ=Asia/Manila so local time is PH)
#   3. UTC
import os
from datetime import datetime, timedelta, timezone

DEFAULT_CONTRIB_SNAPSHOT_HOURS = 6


def parse_offset(raw):
    """Parse '+08:00' / '+0800' / '8' / '-5' / '5:30' into a fixed timezone."""
    text = str(raw or "").strip()
    if not text:
        return None
    sign = 1
    if text[0] in "+-":
        sign = -1 if text[0] == "-" else 1
        text = text[1:]
    text = text.replace(":", "").strip()
    if not text.isdigit():
        return None
    if len(text) <= 2:
        hours, minutes = int(text), 0
    else:
        hours, minutes = int(text[:-2]), int(text[-2:])
    if hours > 23 or minutes > 59:
        return None
    return timezone(sign * timedelta(hours=hours, minutes=minutes))


def app_tz():
    """The timezone daily records are bucketed in."""
    explicit = parse_offset(os.environ.get("APP_UTC_OFFSET", ""))
    if explicit is not None:
        return explicit
    return datetime.now().astimezone().tzinfo or timezone.utc


def app_now():
    """Current time in the app timezone."""
    return datetime.now(app_tz())


def app_today():
    """The local date that contributions are currently being recorded under."""
    return app_now().date()


def utc_offset_str():
    offset = app_now().utcoffset() or timedelta(0)
    total = int(offset.total_seconds())
    sign = "-" if total < 0 else "+"
    total = abs(total)
    return f"{sign}{total // 3600:02d}:{(total % 3600) // 60:02d}"


def tz_name():
    return app_now().tzname() or "UTC"


def contrib_snapshot_hours():
    """How often (hours) to refresh the "so far today" reading.

    0 keeps only the once-a-day baseline (cheapest: one fetch per member/day).
    """
    raw = os.environ.get("CONTRIB_SNAPSHOT_HOURS")
    if raw is None or str(raw).strip() == "":
        return DEFAULT_CONTRIB_SNAPSHOT_HOURS
    try:
        return max(0, int(float(str(raw).strip())))
    except ValueError:
        return DEFAULT_CONTRIB_SNAPSHOT_HOURS


def tz_info():
    """Timezone facts for /api/status and the PH clock indicator."""
    explicit = parse_offset(os.environ.get("APP_UTC_OFFSET", ""))
    return {
        "utc_offset": utc_offset_str(),
        "tz_name": tz_name(),
        "source": "APP_UTC_OFFSET" if explicit is not None else "server local time",
        "tz_env": os.environ.get("TZ", "") or None,
        "now": app_now().isoformat(timespec="seconds"),
        "today": app_today().isoformat(),
        "contrib_snapshot_hours": contrib_snapshot_hours(),
    }
