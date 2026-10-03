"""Print a one-page setup report: why sync works, or why it does not.

    python scripts/diagnose.py
    python scripts/diagnose.py --json
    python scripts/diagnose.py --no-probe     # skip the live API call
"""
import argparse
import json
import os
import sys

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(PROJECT_ROOT, ".env"))

import diagnostics  # noqa: E402
import runtime_state  # noqa: E402

STATUS = {True: "PASS", False: "FAIL", None: "SKIP"}


def api_line(api):
    """(ok, detail) for the CoC API row."""
    live = api.get("live") or {}
    if api["code"] == "OK" and live.get("ok"):
        return True, (f"{live.get('name')} ({live.get('tag')}) - "
                      f"{live.get('members')} members")
    if api["code"] == "IP_NOT_WHITELISTED":
        ip = (api.get("egress") or {}).get("ip") or "unknown"
        return False, (f"IP not whitelisted: this machine is {ip}, the key allows "
                       f"{', '.join(api['allowed_cidrs']) or 'nothing'}")
    if api["code"] == "IP_UNKNOWN":
        return None, "IP not checked: " + str((api.get("egress") or {}).get("error"))
    return False, api.get("message") or live.get("error") or str(api["code"])


def database_line(database):
    if database["reachable"]:
        total = sum(v for v in database["tables"].values() if isinstance(v, int))
        return True, f"{database['backend']} reachable - {total} rows across {len(database['tables'])} tables"
    missing = [name for name, count in database["tables"].items() if count is None]
    if missing:
        return False, f"{database['backend']}: cannot read {', '.join(missing)}"
    return False, f"{database['backend']}: {database['error'] or 'unreachable'}"


def render(report):
    api = report["api"]
    rows = [
        ("CoC API key",) + api_line(api),
        ("Database",) + database_line(report["database"]),
        ("Timezone", report["timezone"]["match"],
         f"UTC{report['timezone']['effective_offset']} ({report['timezone']['source']})"
         f" - today {report['timezone']['today']}"),
        ("Admin key", not report["admin_key"]["weak"],
         "set" if report["admin_key"]["present"] else "missing"),
    ]
    lines = [f"CoC Attack Tracker - setup check ({report['generated_at']})", ""]
    for label, ok, detail in rows:
        lines.append(f"[{STATUS.get(ok, 'FAIL'):4}] {label:12} {detail}")
    last = runtime_state.last_sync()
    if last:
        lines.append(
            f"[{'PASS' if last.get('ok') else 'FAIL':4}] {'Last sync':12} "
            f"{last.get('at')} ({last.get('source')}) "
            + (str(last.get("result")) if last.get("ok") else str(last.get("error")))
        )
    if api.get("token_tail"):
        lines.append(
            f"\nToken tail ...{api['token_tail']}  issued {api.get('issued_at')}  "
            f"tier {api.get('tier')}\nKey allows: "
            f"{', '.join(api['allowed_cidrs']) or 'unknown'}"
        )
    if report["problems"]:
        lines.append("\nProblems and fixes:")
        for problem in report["problems"]:
            lines.append(f"  * {problem['code']}: {problem['message']}")
            if problem.get("fix"):
                lines.append(f"    fix: {problem['fix']}")
    else:
        lines.append("\nNo problems found.")
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="raw report")
    parser.add_argument("--no-probe", action="store_true",
                        help="skip the live clan call")
    parser.add_argument("--no-cache", action="store_true",
                        help="ignore the cached report")
    args = parser.parse_args(argv)

    report = diagnostics.collect(probe=not args.no_probe, use_cache=not args.no_cache)
    if args.json:
        print(json.dumps(report, indent=2, default=str))
    else:
        print(render(report))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
