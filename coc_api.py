# CoC API client for the official Clash of Clans developer API.
# https://developer.clashofclans.com
#
# Two facts drive most of this module:
#
#   * The token is a JWT whose `limits` claim pins the key to a set of IP
#     addresses (`cidrs`). Calling from any other address returns 403 with
#     reason "accessDenied.invalidIp", so `decode_token_claims()` reads those
#     claims (no signature check - they are client-side metadata) and the error
#     message tells the operator exactly which IP is allowed.
#   * Supercell allows one key per IP and at most 10 keys per account, which is
#     why `scripts/refresh_key.py` exists.
import base64
import json
import logging
import os
import time
import urllib.parse

import requests

logger = logging.getLogger(__name__)

BASE_URL = "https://cocproxy.royaleapi.dev/v1"
MAX_ATTEMPTS = 3
BACKOFF_SECONDS = 2.0
RETRY_STATUSES = (429, 500, 502, 503, 504)

_session = requests.Session()


class CocApiError(Exception):
    """Raised when the CoC API returns an error or is unreachable.

    Carries the HTTP status, Supercell's `reason` string, and the CIDRs the
    key allows so callers (diagnostics, the UI) can act on the failure instead
    of just printing it.
    """

    def __init__(self, message, status=None, reason=None, allowed_cidrs=None):
        super().__init__(message)
        self.status = status
        self.reason = reason
        self.allowed_cidrs = list(allowed_cidrs or [])


def token():
    """The configured API token (JWT), or raise when it is missing."""
    value = os.environ.get("COC_API_TOKEN", "").strip()
    if not value:
        raise CocApiError(
            "COC_API_TOKEN is not set. Add it to .env (local) or Vercel env vars."
        )
    return value


def decode_token_claims(value=None):
    """Read the JWT payload (iat/scopes/limits) without verifying the signature.

    Diagnostics only: the payload is metadata Supercell hands to the client at
    login and reading it never involves the signing secret. Never use these
    claims for a security decision.
    """
    raw = (value or token()).strip()
    parts = raw.split(".")
    if len(parts) < 2:
        raise CocApiError("COC_API_TOKEN does not look like a JWT (expected a.b.c).")
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as exc:
        raise CocApiError(f"Could not decode COC_API_TOKEN: {exc}") from exc


def token_cidrs(value=None):
    """IP addresses / ranges this token may be used from."""
    cidrs = []
    for limit in decode_token_claims(value).get("limits") or []:
        if isinstance(limit, dict) and limit.get("type") == "client":
            cidrs.extend(str(item) for item in limit.get("cidrs") or [])
    return cidrs


def token_tier(value=None):
    """The throttling tier Supercell assigned to this key."""
    for limit in decode_token_claims(value).get("limits") or []:
        if isinstance(limit, dict) and limit.get("type") == "throttling":
            return limit.get("tier")
    return None


def _headers():
    return {"Authorization": f"Bearer {token()}", "Accept": "application/json"}


def clan_tag():
    tag = os.environ.get("CLAN_TAG", "").strip()
    if not tag:
        raise CocApiError("CLAN_TAG is not set.")
    return tag


def _explain_403(response):
    """Turn Supercell's 403 into a message an operator can act on."""
    reason = ""
    try:
        reason = response.json().get("reason", "")
    except ValueError:
        pass
    allowed = token_cidrs()
    message = (
        "CoC API returned 403: the key is not valid from this address."
        f" reason={reason or 'unknown'};"
        f" key allows: {', '.join(allowed) or 'unknown'}."
        " Fix: run `python scripts/refresh_key.py`, or add this machine's IP at"
        " developer.clashofclans.com."
    )
    return CocApiError(message, status=403, reason=reason, allowed_cidrs=allowed)


def _get(path, params=None):
    """GET through a shared session with retry/backoff and actionable errors."""
    url = f"{BASE_URL}{path}"
    attempt = 0
    while True:
        attempt += 1
        try:
            response = _session.get(
                url, headers=_headers(), params=params or {}, timeout=20
            )
        except requests.RequestException as exc:
            if attempt >= MAX_ATTEMPTS:
                raise CocApiError(f"Could not reach the CoC API: {exc}") from exc
            time.sleep(BACKOFF_SECONDS * attempt)
            continue
        if response.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
            logger.warning(
                "CoC API %s on %s - retrying (%s/%s)",
                response.status_code, path, attempt, MAX_ATTEMPTS,
            )
            time.sleep(BACKOFF_SECONDS * attempt)
            continue
        if response.status_code == 403:
            raise _explain_403(response)
        if response.status_code == 404:
            raise CocApiError("CoC API returned 404: clan/tag not found.", status=404)
        if response.status_code == 429:
            raise CocApiError(
                "CoC API rate limit reached (429) after retries - try again shortly.",
                status=429,
            )
        if not response.ok:
            raise CocApiError(
                f"CoC API error {response.status_code}: {response.text[:200]}",
                status=response.status_code,
            )
        return response.json()


def encode_tag(tag):
    """Clan/player tags start with '#', which must be URL-encoded in paths."""
    return urllib.parse.quote(tag.strip(), safe="")


def get_clan():
    return _get(f"/clans/{encode_tag(clan_tag())}")


def get_members():
    data = _get(f"/clans/{encode_tag(clan_tag())}/members")
    return data.get("items", [])


def get_player(player_tag):
    """Single player profile.

    NOTE: `clanCapitalContributions` (lifetime capital gold contributed) is
    only exposed here - it is absent from /clans/{tag} and
    /clans/{tag}/members, so tracking contributions costs one call per member.
    """
    return _get(f"/players/{encode_tag(player_tag)}")


def get_warlog():
    data = _get(f"/clans/{encode_tag(clan_tag())}/warlog", {"limit": 20})
    return data.get("items", [])


def get_current_war():
    return _get(f"/clans/{encode_tag(clan_tag())}/currentwar")


def get_capital_raidseasons():
    data = _get(f"/clans/{encode_tag(clan_tag())}/capitalraidseasons", {"limit": 12})
    return data.get("items", [])
