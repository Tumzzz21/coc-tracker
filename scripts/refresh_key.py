"""Refresh COC_API_TOKEN so it matches this machine's current public IP.

Supercell pins every API key to the IP address(es) you whitelist and allows at
most 10 keys per developer account. A rotating residential IP therefore breaks
every sync with HTTP 403 until the key is replaced - the failure mode this
script automates away:

  1. read .env (COC_API_TOKEN, CLAN_TAG, COC_DEV_EMAIL, COC_DEV_PASSWORD)
  2. work out the current public IP (or take --ip / --cidr)
  3. decode the token that is already there; keep it if it covers that IP
  4. otherwise log in to the developer portal and create (or reuse) a key,
     revoking the oldest non-whitelisted key when the account is at the cap
  5. verify the candidate with a real clan call, then rewrite COC_API_TOKEN in
     .env atomically. The secret is never printed.

Exit codes: 0 ok/unchanged, 2 login failed, 3 create failed, 4 verify failed,
5 missing credentials / usage error.

The portal endpoints are undocumented (see coc_portal.py). When login or create
fails, the script prints the manual steps instead of guessing.

Examples
--------
    python scripts/refresh_key.py --dry-run
    python scripts/refresh_key.py
    python scripts/refresh_key.py --cidr 136.158.10.0/24 --keep prod-key
    python scripts/refresh_key.py --quiet          # Task Scheduler / cron
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

import coc_api  # noqa: E402
import coc_portal  # noqa: E402

DEFAULT_ENV = os.path.join(PROJECT_ROOT, ".env")
EXIT_OK = 0
EXIT_LOGIN = 2
EXIT_CREATE = 3
EXIT_VERIFY = 4
EXIT_USAGE = 5
MANAGED_KEYS = ("COC_API_TOKEN", "COC_KEY_CIDRS", "COC_KEY_REFRESHED_AT")


# ---- .env handling --------------------------------------------------------
def read_env_file(path):
    """{KEY: value} for a dotenv-style file (comments and blanks ignored)."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, _, value = text.partition("=")
            values[key.strip()] = value.strip()
    return values


def write_env_values(path, updates):
    """Rewrite `updates` in place, appending keys that are not there yet.

    The file is written to a sibling temp file and then moved over the original
    so a crash can never leave a half-written .env. Returns the keys written.
    """
    raw = ""
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8", newline="") as handle:
            raw = handle.read()
    newline = "\r\n" if "\r\n" in raw else "\n"
    lines = raw.splitlines() if raw else []
    pending = dict(updates)
    written = []

    for index, line in enumerate(lines):
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key = text.partition("=")[0].strip()
        if key in pending:
            lines[index] = f"{key}={pending.pop(key)}"
            written.append(key)

    if pending:
        if lines and lines[-1].strip():
            lines.append("")
        lines.append("# Refreshed by scripts/refresh_key.py")
        for key in MANAGED_KEYS:
            if key in pending:
                lines.append(f"{key}={pending.pop(key)}")
                written.append(key)
        for key, value in pending.items():
            lines.append(f"{key}={value}")
            written.append(key)

    with open(path + ".tmp", "w", encoding="utf-8", newline="") as handle:
        handle.write(newline.join(lines) + newline)
    os.replace(path + ".tmp", path)
    return written


def git_ignored(path):
    """True / False, or None when the path is not inside a git work tree."""
    directory = os.path.dirname(path) or "."
    try:
        proc = subprocess.run(
            ["git", "check-ignore", "-q", "--", os.path.basename(path)],
            cwd=directory, capture_output=True,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode == 0:
        return True
    return False if proc.returncode == 1 else None


# ---- IP + key selection ---------------------------------------------------
def current_ip(explicit=None):
    """The public IP Supercell will see, or None when it cannot be resolved."""
    if explicit:
        return explicit.strip()
    import requests

    urls = [os.environ.get("EGRESS_IP_LOOKUP_URL", "https://api.ipify.org"),
            "https://ifconfig.me/ip"]
    for url in urls:
        try:
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            candidate = response.text.strip()
            if candidate:
                return candidate
        except Exception:
            continue
    return None


def requested_ranges(args):
    """The CIDR ranges / IPs to whitelist on the key."""
    if args.cidr:
        return [item.strip() for item in args.cidr if item.strip()]
    ip = current_ip(args.ip)
    return [ip] if ip else []


def _covers(key, item):
    """Does this key already allow `item` (an IP or a CIDR string)?"""
    ranges = key.get("cidrRanges") or []
    if "/" in item:
        return any(str(entry).strip() == item for entry in ranges)
    return coc_portal.ip_in_ranges(item, ranges)


def build_plan(ranges, keys, keep, max_keys):
    """Decide what to do without touching the portal."""
    if any(_covers(key, item) for key in keys for item in ranges):
        known = next(key for key in keys if any(_covers(key, item) for item in ranges))
        return {"action": "reuse", "key": known, "ranges": ranges}
    if len(keys) < max_keys:
        return {"action": "create", "key": None, "ranges": ranges, "revoke": None}
    keep_set = set(keep or [])
    candidates = [key for key in keys if key.get("name") not in keep_set]
    if not candidates:
        return {
            "action": "blocked",
            "reason": f"all {len(keys)} keys are protected by --keep; revoke one at "
                      f"{coc_portal.PORTAL_PAGE}",
            "ranges": ranges,
        }
    victims = sorted(candidates, key=lambda key: int(key.get("id") or 0))
    return {
        "action": "create_and_revoke", "key": None, "revoke": victims[0],
        "ranges": ranges,
    }


def verify(token_value):
    """Prove the candidate token works before it is written to .env."""
    previous = os.environ.get("COC_API_TOKEN")
    os.environ["COC_API_TOKEN"] = token_value
    try:
        clan = coc_api.get_clan()
        return True, f"{clan.get('name')} ({clan.get('tag')})"
    except coc_api.CocApiError as exc:
        return False, str(exc)
    finally:
        if previous is None:
            os.environ.pop("COC_API_TOKEN", None)
        else:
            os.environ["COC_API_TOKEN"] = previous


def say(args, message):
    if not args.quiet:
        print(message)


def describe(plan):
    action = plan["action"]
    if action == "reuse":
        return (f"reuse existing key '{plan['key'].get('name')}' "
                f"(id={plan['key'].get('id')})")
    if action == "create":
        return f"create a new key for {', '.join(plan['ranges'])}"
    if action == "create_and_revoke":
        return (f"create a new key for {', '.join(plan['ranges'])} and revoke "
                f"'{plan['revoke'].get('name')}' (id={plan['revoke'].get('id')})")
    return f"blocked: {plan.get('reason')}"


# ---- CLI ------------------------------------------------------------------
def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Refresh COC_API_TOKEN for this machine's current public IP.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--env-file", default=DEFAULT_ENV,
                        help="path to .env (default: %(default)s)")
    parser.add_argument("--ip", help="use this IP instead of looking it up")
    parser.add_argument("--cidr", action="append",
                        help="whitelist this CIDR instead of one IP (repeatable)")
    parser.add_argument("--keep", action="append", default=[],
                        help="key NAME that must never be revoked (repeatable)")
    parser.add_argument("--email", help="portal email (default: COC_DEV_EMAIL)")
    parser.add_argument("--password", help="portal password (default: COC_DEV_PASSWORD)")
    parser.add_argument("--max-keys", type=int, default=coc_portal.MAX_KEYS,
                        help="account key cap (default: %(default)s)")
    parser.add_argument("--no-verify", action="store_true",
                        help="skip the live clan call (not recommended)")
    parser.add_argument("--dry-run", action="store_true",
                        help="show the plan, change nothing")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    parser.add_argument("--quiet", action="store_true", help="only report problems")
    parser.add_argument("--allow-tracked", action="store_true",
                        help="write .env even when git does not ignore it (dangerous)")
    return parser.parse_args(argv)


def already_covered(ranges, allowed):
    """True when every requested range is already whitelisted on the token."""
    known = [str(item).strip() for item in allowed]
    for item in ranges:
        if "/" in item:
            if item not in known:
                return False
        elif not coc_portal.ip_in_ranges(item, allowed):
            return False
    return True


def emit(args, result):
    """Print the JSON report or the human-readable problems."""
    if args.json:
        print(json.dumps(result, indent=2, default=str))
        return
    if result.get("warning"):
        print(f"WARNING: {result['warning']}", file=sys.stderr)
    if not result.get("ok"):
        for line in ("error", "manual"):
            if result.get(line):
                print(f"{line.upper()}: {result[line]}", file=sys.stderr)


def main(argv=None):
    args = parse_args(argv)
    result = {"env_file": args.env_file, "ok": False, "changed": [], "action": None}

    # The .env file is the source of truth; env vars already set win, matching
    # python-dotenv's default behaviour in app.py.
    file_env = read_env_file(args.env_file)
    for key, value in file_env.items():
        os.environ.setdefault(key, value)

    if git_ignored(args.env_file) is False and not args.allow_tracked:
        result["error"] = (
            f"{args.env_file} is not git-ignored - refusing to write a secret into "
            "a tracked file (use --allow-tracked to override)."
        )
        emit(args, result)
        return EXIT_USAGE

    ranges = requested_ranges(args)
    if not ranges:
        result["error"] = (
            "Could not determine this machine's public IP - pass --ip/--cidr or set "
            "EGRESS_IP_LOOKUP_URL."
        )
        emit(args, result)
        return EXIT_USAGE
    result["ranges"] = ranges

    current = os.environ.get("COC_API_TOKEN", "").strip()
    allowed = []
    if current:
        try:
            allowed = coc_api.token_cidrs(current)
        except coc_api.CocApiError as exc:
            result["note"] = f"the current token could not be decoded: {exc}"
        result["current_cidrs"] = allowed

    if current and already_covered(ranges, allowed):
        say(args, f"OK: the token already allows {', '.join(ranges)} - nothing to do.")
        pending = {}
        if file_env.get("COC_KEY_CIDRS", "").strip() != ", ".join(ranges):
            pending["COC_KEY_CIDRS"] = ", ".join(ranges)
            pending["COC_KEY_REFRESHED_AT"] = datetime.now(timezone.utc).isoformat(
                timespec="seconds"
            )
        if pending:
            result["changed"] = write_env_values(args.env_file, pending)
        result.update(ok=True, action="none", verified=None)
        emit(args, result)
        return EXIT_OK

    email = (args.email or os.environ.get("COC_DEV_EMAIL", "")).strip()
    password = (args.password or os.environ.get("COC_DEV_PASSWORD", "")).strip()
    if not password and sys.stdin.isatty() and not args.json:
        import getpass

        password = getpass.getpass("Supercell developer portal password: ").strip()
    if not email or not password:
        result["error"] = (
            "Developer portal credentials missing: set COC_DEV_EMAIL and "
            "COC_DEV_PASSWORD in .env (or pass --email/--password)."
        )
        result["manual"] = (
            f"Or open {coc_portal.PORTAL_PAGE} and add {', '.join(ranges)} to a key."
        )
        emit(args, result)
        return EXIT_USAGE

    client = coc_portal.PortalClient(email, password)
    try:
        keys = client.list_keys()
    except coc_portal.PortalError as exc:
        result["error"] = str(exc)
        result["manual"] = (
            f"Add {', '.join(ranges)} to your key at {coc_portal.PORTAL_PAGE}."
        )
        emit(args, result)
        return EXIT_LOGIN

    result["keys"] = [
        {"id": key.get("id"), "name": key.get("name"),
         "cidrRanges": key.get("cidrRanges")}
        for key in keys
    ]
    plan = build_plan(ranges, keys, args.keep, args.max_keys)
    result["action"] = plan["action"]
    result["plan"] = describe(plan)
    say(args, f"Plan: {describe(plan)}")

    if plan["action"] == "blocked":
        result["error"] = plan["reason"]
        emit(args, result)
        return EXIT_CREATE
    if args.dry_run:
        result.update(ok=True, dry_run=True)
        emit(args, result)
        return EXIT_OK


    candidate = ""
    created = None
    if plan["action"] == "reuse":
        candidate = str(plan["key"].get("key") or "").strip()
        if candidate:
            say(args, f"Reusing key id={plan['key'].get('id')}.")
        else:
            say(args, "A matching key exists but the portal hid its secret; creating a new one.")

    if not candidate:
        try:
            created = client.create_key(plan["ranges"])
        except coc_portal.PortalError as exc:
            result["error"] = str(exc)
            result["manual"] = (
                f"Add {', '.join(ranges)} to your key at {coc_portal.PORTAL_PAGE}."
            )
            emit(args, result)
            return EXIT_CREATE
        candidate = str(created.get("key") or "").strip()
        result["created"] = {
            "id": created.get("id"), "name": created.get("name"),
            "cidrRanges": created.get("cidrRanges"),
        }
        say(args, f"Created key '{created.get('name')}' (id={created.get('id')}).")
        if plan.get("revoke"):
            try:
                client.revoke_key(plan["revoke"].get("id"))
                result["revoked"] = {
                    "id": plan["revoke"].get("id"), "name": plan["revoke"].get("name"),
                }
                say(args, f"Revoked '{plan['revoke'].get('name')}'.")
            except coc_portal.PortalError as exc:
                result["warning"] = f"Could not revoke the old key: {exc}"

    if not candidate:
        result["error"] = "The developer portal returned an empty key."
        emit(args, result)
        return EXIT_CREATE

    if not args.no_verify:
        ok, detail = verify(candidate)
        result["verified"] = ok
        result["verify_detail"] = detail
        if not ok:
            result["error"] = f"Live verification failed: {detail}"
            result["manual"] = (
                f"Add {', '.join(ranges)} to your key at {coc_portal.PORTAL_PAGE}."
            )
            emit(args, result)
            return EXIT_VERIFY
        say(args, f"Verified against the live API: {detail}")

    written_cidrs = ", ".join(
        (created.get("cidrRanges") if created else None) or ranges
    )
    written = write_env_values(args.env_file, {
        "COC_API_TOKEN": candidate,
        "COC_KEY_CIDRS": written_cidrs,
        "COC_KEY_REFRESHED_AT": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    result["changed"] = written
    result["ok"] = True
    say(args, f"Updated {args.env_file}: {', '.join(written)}")
    say(args, "Restart the app so the new token is loaded.")
    emit(args, result)
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())




