"""Converts a CloudMailin 'JSON Normalized' webhook payload into a RawEmail, so the
inbound-email webhook (webapp.py) can feed it through the exact same
identify/parse/filter/score pipeline as the polling mailbox adapters.

Payload shape per https://docs.cloudmailin.com/http_post_formats/json_normalized/ :
  {"headers": {"from": "Name <addr>", "to": "...", "subject": "...",
               "message_id": "<...>", "date": "..."},
   "envelope": {"to": "...", "from": "...", "recipients": [...]},
   "plain": "...", "html": "...", "reply_plain": "...", "attachments": [...]}
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from .emailutil import split_name_addr
from .models import RawEmail

_TAG_PATTERN = re.compile(r"<[^>]+>")


class InboundPayloadError(ValueError):
    pass


def _strip_html(html: str) -> str:
    """Crude HTML->text fallback for when CloudMailin doesn't supply 'plain'
    (HARO digests are plain-text, so this path should rarely if ever trigger)."""
    text = _TAG_PATTERN.sub(" ", html or "")
    return re.sub(r"[ \t]+", " ", text).strip()


def parse_cloudmailin_payload(data: dict) -> RawEmail:
    if not isinstance(data, dict):
        raise InboundPayloadError("Payload is not a JSON object")

    headers = data.get("headers") or {}
    envelope = data.get("envelope") or {}

    from_header = headers.get("from") or envelope.get("from") or ""
    sender_name, sender = split_name_addr(from_header)
    if not sender:
        sender = envelope.get("from", "")

    subject = headers.get("subject") or ""
    body = data.get("plain") or _strip_html(data.get("html", ""))

    raw_message_id = headers.get("message_id")
    if raw_message_id:
        message_id = raw_message_id.strip().strip("<>")
    else:
        # No Message-Id header (rare, but not something to crash on) - derive a
        # stable id from envelope+subject+date so a retried delivery of the same
        # email doesn't get treated as a second, new one.
        basis = f"{envelope.get('from', '')}|{envelope.get('to', '')}|{subject}|{headers.get('date', '')}"
        message_id = "cloudmailin:" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]

    return RawEmail(
        message_id=message_id,
        sender=sender,
        sender_name=sender_name,
        subject=subject,
        received_at=datetime.now(timezone.utc),
        body=body,
    )
