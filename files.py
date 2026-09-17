"""Uploads for file-driven agents.

Some agents exist to process a document - the mid-campaign reporter wants one
`.xlsx` and does nothing without it. A browser upload is invisible to an agent,
so the file is written to a Unity Catalog volume and its path is named in the
turn; the agent then reads it with its own volume tool.

The upload is performed with the **user's** token, so Unity Catalog decides
whether they may write there. An admin declares the destination per agent via
the `upload_volume` tag, which keeps the capability declaration in Databricks
rather than in a config file here.
"""
from __future__ import annotations

import posixpath
import re
import time

import httpx

from dbx import DbxError, host

MAX_BYTES = 100 * 1024 * 1024
SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _clean(name: str) -> str:
    base = posixpath.basename((name or "").replace("\\", "/")).strip() or "upload"
    base = SAFE.sub("_", base).lstrip(".") or "upload"
    return base[:120]


def volume_path(volume: str, filename: str) -> str:
    """Build a collision-free path inside `catalog.schema.volume`."""
    v = (volume or "").strip().strip("/")
    if v.startswith("Volumes/"):
        v = v[len("Volumes/") :]
    parts = v.replace(".", "/").split("/")
    if len(parts) < 3 or not all(parts[:3]):
        raise DbxError(
            "This agent's upload location is not set correctly. Expected "
            "catalog.schema.volume, got " + repr(volume) + ".",
            400,
        )
    root = "/".join(parts[:3])
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return "/Volumes/" + root + "/uploads/" + stamp + "-" + _clean(filename)


def upload(volume: str, filename: str, blob: bytes, user_tok: str) -> dict:
    """Write one file to the agent's volume as the signed-in user."""
    if not blob:
        raise DbxError("that file is empty", 400)
    if len(blob) > MAX_BYTES:
        raise DbxError("that file is larger than the 100 MB limit", 413)

    path = volume_path(volume, filename)
    try:
        resp = httpx.put(
            host() + "/api/2.0/fs/files" + path,
            headers={
                "Authorization": "Bearer " + user_tok,
                "Content-Type": "application/octet-stream",
            },
            content=blob,
            params={"overwrite": "true"},
            timeout=300,
        )
    except httpx.RequestError as exc:
        raise DbxError("could not reach the file store: " + str(exc), 504)

    if resp.status_code >= 400:
        detail = (resp.text or "")[:300]
        if resp.status_code in (401, 403):
            raise DbxError(
                "You do not have permission to upload to this agent's folder ("
                + path.rsplit("/", 1)[0]
                + "). An admin needs to grant you WRITE VOLUME on it. " + detail,
                403,
            )
        if resp.status_code == 404:
            raise DbxError(
                "This agent's upload folder does not exist: " + path.rsplit("/", 1)[0] + ".",
                404,
            )
        raise DbxError(detail or "upload failed", resp.status_code)

    return {"path": path, "name": posixpath.basename(path), "bytes": len(blob)}
