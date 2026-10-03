# In-memory record of the last sync attempt.
#
# `sync_log` is the durable history, but it lives in the database - which is
# exactly what is broken when a sync fails. Keeping the latest attempt (and the
# last failure) in memory means /api/status can still explain what happened.
import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_last = {
    "at": None,
    "ok": None,
    "source": None,
    "result": None,
    "error": None,
}


def record_sync(ok, result, source="unknown"):
    """Remember one sync attempt. `result` is a summary dict or an error string."""
    with _lock:
        _last["at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _last["ok"] = bool(ok)
        _last["source"] = source
        if ok:
            _last["result"] = result
            _last["error"] = None
        else:
            _last["result"] = None
            _last["error"] = str(result)[:300]


def last_sync():
    """A copy of the last attempt (or None when the process has not synced yet)."""
    with _lock:
        if _last["at"] is None:
            return None
        return dict(_last)


def reset():
    """Test helper."""
    with _lock:
        _last.update(at=None, ok=None, source=None, result=None, error=None)
