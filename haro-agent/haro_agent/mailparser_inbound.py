"""Converts a Mailparser.io webhook payload into a RawEmail, so the
/webhook/inbound-email-mailparser route (webapp.py) can feed it through the exact
same identify/parse/filter/score pipeline as the CloudMailin webhook and the
polling mailbox adapters.

Mailparser has no built-in "whole raw body" system field - the body text comes
from a custom parsing rule (source: Body, Plain Text, no filters) named
"Mail Body", which Mailparser flattens to the JSON key "mail_body". A "Subject"
rule (source: Subject, no filter) supplies "subject" the same way. Mailparser's
own system tokens ({{id}}, {{received_at_iso8601}}) aren't reliably present in
the JSON body across "Include Fields" settings, so those are instead passed as
query-string parameters on the configured Target URL (see README) and read from
request.args rather than the JSON body.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timezone


class MailparserPayloadError(ValueError):
    pass


def parse_mailparser_payload(data: dict, message_id: str | None, received_at: str | None):
    from .models import RawEmail

    if not isinstance(data, dict):
        raise MailparserPayloadError("Payload is not a JSON object")

    body = data.get("mail_body") or ""
    subject = data.get("subject") or ""
    if not body:
        raise MailparserPayloadError("Payload has no 'mail_body' field")

    if received_at:
        try:
            received_dt = datetime.fromisoformat(received_at.replace("Z", "+00:00"))
        except ValueError:
            received_dt = datetime.now(timezone.utc)
    else:
        received_dt = datetime.now(timezone.utc)

    if not message_id:
        basis = f"{subject}|{body[:200]}"
        message_id = "mailparser:" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]

    return RawEmail(
        message_id=message_id,
        sender="",
        sender_name="",
        subject=subject,
        received_at=received_dt,
        body=body,
    )
