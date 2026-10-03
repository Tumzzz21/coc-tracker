# Tests for config/timeutil.py: fixed-offset parsing and day bucketing.
from datetime import datetime

import pytest

from config import timeutil as tu


@pytest.mark.parametrize("raw,expected_hours", [
    ("+08:00", 8),
    ("+0800", 8),
    ("8", 8),
    ("-5", -5),
    ("5:30", 5.5),
    ("+05:30", 5.5),
])
def test_parse_offset_accepts_common_forms(raw, expected_hours):
    tz = tu.parse_offset(raw)
    assert tz is not None
    offset = tz.utcoffset(datetime.now(tz))
    assert offset.total_seconds() == expected_hours * 3600


@pytest.mark.parametrize("raw", ["", None, "abc", "+25:00", "+08:99", "++8"])
def test_parse_offset_rejects_garbage(raw):
    assert tu.parse_offset(raw) is None


def test_app_tz_prefers_explicit_offset(monkeypatch):
    monkeypatch.setenv("APP_UTC_OFFSET", "+05:30")
    tz = tu.app_tz()
    assert tz.utcoffset(datetime.now(tz)).total_seconds() == 5.5 * 3600


def test_app_today_matches_app_tz(monkeypatch):
    monkeypatch.setenv("APP_UTC_OFFSET", "+08:00")
    assert tu.app_today() == tu.app_now().date()


def test_utc_offset_str_format(monkeypatch):
    monkeypatch.setenv("APP_UTC_OFFSET", "-03:30")
    assert tu.utc_offset_str() == "-03:30"


def test_tz_info_reports_source(monkeypatch):
    monkeypatch.setenv("APP_UTC_OFFSET", "+08:00")
    info = tu.tz_info()
    assert info["source"] == "APP_UTC_OFFSET"
    assert info["utc_offset"] == "+08:00"
    assert info["today"] == tu.app_today().isoformat()
