# Pytest bootstrap: project root on sys.path + a DB-reachability marker.
#
# Unit tests never need MySQL; the scoring tests do, and they skip themselves
# with a clear reason when XAMPP MySQL is not running.
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import pytest

from config import db


def _db_reachable():
    try:
        conn = db.get_connection()
        conn.close()
        return True
    except Exception:
        return False


requires_db = pytest.mark.skipif(
    not os.environ.get("SKIP_DB_TESTS") and not _db_reachable(),
    reason="database not reachable (start MySQL, or set SKIP_DB_TESTS=1)",
)
