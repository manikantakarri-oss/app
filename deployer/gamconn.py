"""A client's Google Ad Manager connection: check a service-account key and
list the GAM networks it can see, before it is saved.

Uses the Ad Manager REST API (admanager.googleapis.com/v1/networks), which
needs only google-auth, not the large SOAP library the planner tool uses.
Seen live (Oct 2026): a key whose account is a GAM user lists that network
with its code, currency and time zone. Read-only; the key is never logged.
"""
from __future__ import annotations

import json
import time

import httpx

from common import DeployError

SCOPE = "https://www.googleapis.com/auth/admanager"
TOKEN_URI = "https://oauth2.googleapis.com/token"


def parse_key(text: str) -> dict:
    """The key as a dict, or a plain refusal. Only service-account keys."""
    try:
        key = json.loads(text or "")
    except ValueError as exc:
        raise DeployError("That file is not valid JSON. Upload the service account key file from Google Cloud.") from exc
    if not isinstance(key, dict) or key.get("type") != "service_account":
        raise DeployError("That is not a service account key. In Google Cloud, create a key for the service account "
                          "that was added to Google Ad Manager, and upload that file.")
    for field in ("client_email", "private_key", "token_uri"):
        if not key.get(field):
            raise DeployError("The key file is missing %s." % field)
    if len(text) > 20000:
        raise DeployError("That file is too large to be a service account key.")
    return key


def _token(key: dict) -> str:
    from google.auth import crypt, jwt

    now = int(time.time())
    signer = crypt.RSASigner.from_service_account_info(key)
    assertion = jwt.encode(signer, {"iss": key["client_email"], "scope": SCOPE, "aud": key.get("token_uri") or TOKEN_URI,
                                    "iat": now, "exp": now + 600})
    if isinstance(assertion, bytes):
        assertion = assertion.decode()
    r = httpx.post(key.get("token_uri") or TOKEN_URI, data={
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": assertion}, timeout=30)
    if r.status_code != 200:
        raise DeployError("Google refused the key (HTTP %d). It may have been deleted or disabled in Google Cloud."
                          % r.status_code, 400)
    return r.json()["access_token"]


def test(text: str) -> dict:
    """{account, networks: [{code, name, currency, time_zone}]}. No networks
    means the account is not (yet) a user in any Ad Manager network."""
    key = parse_key(text)
    tok = _token(key)
    r = httpx.get("https://admanager.googleapis.com/v1/networks", headers={"Authorization": "Bearer " + tok}, timeout=30)
    if r.status_code == 403:
        raise DeployError("Google Ad Manager refused this account. Make sure API access is turned on in the network "
                          "(Admin > Global settings) and the account is added as a user.", 400)
    if r.status_code >= 400:
        raise DeployError("Google Ad Manager could not be read (HTTP %d)." % r.status_code, 502)
    nets = [{"code": str(n.get("networkCode") or ""), "name": n.get("displayName") or "",
             "currency": n.get("currencyCode") or "", "time_zone": n.get("timeZone") or ""}
            for n in r.json().get("networks") or []]
    return {"account": key["client_email"], "networks": [n for n in nets if n["code"].isdigit()]}
