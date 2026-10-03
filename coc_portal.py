# Client for the (undocumented) Supercell developer portal.
#
# The game API cannot create or update keys, but the portal's own web UI talks
# to these endpoints - the same ones community tools rely on:
#
#   POST /api/login          {email, password}
#   POST /api/apikey/list    {}
#   POST /api/apikey/create  {cidrRanges, name, description}
#   POST /api/apikey/revoke  {id}
#
# A successful login returns `swaggerUrl` + `temporaryAPIToken`, and the session
# cookie must be combined with them:
#
#   Cookie: <set-cookie>; game-api-url=<swaggerUrl>; game-api-token=<temporaryAPIToken>
#
# This is NOT an official API: it can change without notice, and it must only
# ever be used with credentials you own. Every failure is surfaced as a
# PortalError with an actionable message so the caller can fall back to the
# manual portal workflow.
import ipaddress
import logging

import requests

PORTAL_URL = "https://developer.clashofclans.com/api"
PORTAL_PAGE = "https://developer.clashofclans.com/#/account"
MAX_KEYS = 10  # Supercell allows at most 10 keys per developer account.
REQUEST_TIMEOUT = 30


class PortalError(Exception):
    """Raised when the developer portal rejects a request."""


def ip_in_ranges(ip, ranges):
    """True when `ip` falls inside any entry of `ranges` (exact IP or CIDR)."""
    try:
        address = ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return False
    for item in ranges or []:
        text = str(item).strip()
        if not text:
            continue
        try:
            if address in ipaddress.ip_network(text, strict=False):
                return True
        except ValueError:
            continue
    return False


def find_key_for(keys, ip):
    """The key whose allowed ranges already cover `ip`, if any."""
    for key in keys or []:
        if ip_in_ranges(ip, key.get("cidrRanges")):
            return key
    return None


class PortalClient:
    """Minimal session against the developer portal key API."""

    def __init__(self, email, password, base_url=PORTAL_URL):
        if not (email or "").strip() or not (password or "").strip():
            raise PortalError(
                "Developer portal credentials missing: set COC_DEV_EMAIL and "
                "COC_DEV_PASSWORD (or pass --email/--password)."
            )
        self.email = email.strip()
        self._password = password
        self.base_url = base_url.rstrip("/")
        self._cookie = None

    # -- internals ---------------------------------------------------------
    def _post(self, path, payload, cookie=None, what="request"):
        try:
            response = requests.post(
                f"{self.base_url}{path}",
                json=payload,
                headers={"Cookie": cookie} if cookie else {},
                timeout=REQUEST_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise PortalError(
                f"Could not reach the developer portal ({what}): {exc}"
            ) from exc
        if not response.ok:
            raise PortalError(
                f"Developer portal {what} failed ({response.status_code}): "
                f"{response.text[:200]}. Fix the key manually at {PORTAL_PAGE}."
            )
        return response

    def login(self):
        """Log in and build the cookie the key endpoints expect."""
        response = self._post(
            "/login",
            {"email": self.email, "password": self._password},
            what="login",
        )
        try:
            data = response.json()
        except ValueError as exc:
            raise PortalError(
                "Developer portal login did not return JSON (wrong credentials, "
                "a captcha, or the endpoint changed)."
            ) from exc
        session_part = (response.headers.get("set-cookie", "") or "").split(";")[0]
        if not session_part:
            raise PortalError(
                "Developer portal login returned no session cookie; the portal "
                f"may have changed. Update the key manually at {PORTAL_PAGE}."
            )
        self._cookie = (
            f"{session_part}; game-api-url={data.get('swaggerUrl', '')};"
            f"game-api-token={data.get('temporaryAPIToken', '')}"
        )
        return self._cookie

    @property
    def cookie(self):
        return self._cookie or self.login()

    # -- key management ----------------------------------------------------
    def list_keys(self):
        response = self._post("/apikey/list", {}, self.cookie, what="key list")
        return response.json().get("keys") or []

    def create_key(self, cidr_ranges, name=None):
        ranges = [str(item).strip() for item in cidr_ranges if str(item).strip()]
        if not ranges:
            raise PortalError("No IP range to whitelist.")
        payload = {
            "cidrRanges": ranges,
            "name": name or f"coc-attack-tracker {ranges[0]}",
            "description": "Key for non-commercial use",
        }
        response = self._post("/apikey/create", payload, self.cookie, what="key create")
        data = response.json()
        key = data.get("key") or data
        if not key.get("key"):
            raise PortalError(f"Developer portal did not return a key: {str(data)[:200]}")
        return key

    def revoke_key(self, key_id):
        self._post("/apikey/revoke", {"id": key_id}, self.cookie, what="key revoke")
