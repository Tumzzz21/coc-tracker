# Dual-database layer: MySQL locally (XAMPP), PostgreSQL (Supabase) on Vercel.
#
# If DATABASE_URL is set, PostgreSQL is used (Supabase). Otherwise the app
# connects to local MySQL using DB_HOST / DB_USER / DB_PASSWORD / DB_NAME.
import os
import re
import urllib.parse

import pymysql

try:
    import psycopg2
    import psycopg2.extras
except ImportError:  # local machines don't need psycopg2
    psycopg2 = None


def _is_postgres():
    return bool(os.environ.get("DATABASE_URL", "").strip())


def _postgres_conn():
    url = os.environ["DATABASE_URL"].strip()
    # Supabase pooler strings come as postgresql://user:pass@host:6543/postgres
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql://", 1)
    parsed = urllib.parse.urlparse(url)
    kwargs = dict(
        host=parsed.hostname,
        port=parsed.port or 5432,
        dbname=(parsed.path or "/").lstrip("/") or "postgres",
        user=urllib.parse.unquote(parsed.username or ""),
        password=urllib.parse.unquote(parsed.password or ""),
        sslmode=os.environ.get("PGSSLMODE", "require"),
    )
    return psycopg2.connect(**kwargs)


def _mysql_conn():
    return pymysql.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        user=os.environ.get("DB_USER", "root"),
        password=os.environ.get("DB_PASSWORD", ""),
        database=os.environ.get("DB_NAME", "coc_tracker"),
        port=int(os.environ.get("DB_PORT", "3306")),
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=True,
    )


def get_connection():
    """Open a connection using whichever backend is configured."""
    if _is_postgres():
        conn = _postgres_conn()
        conn.autocommit = True
        return conn
    return _mysql_conn()


def cursor(conn):
    """Return a dict-producing cursor for the active backend."""
    if _is_postgres():
        return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    return conn.cursor()


def ph(column=None):
    """Dialect-correct placeholder: %s (both drivers accept %s)."""
    return "%s"


def now_sql():
    """SQL expression for the current timestamp in each dialect."""
    return "NOW()" if not _is_postgres() else "NOW()"


def is_postgres():
    return _is_postgres()


def healthcheck():
    """Verify the configured database is reachable; raise on failure."""
    conn = get_connection()
    try:
        cur = cursor(conn)
        cur.execute("SELECT 1")
        cur.fetchone()
        cur.close()
    finally:
        conn.close()
