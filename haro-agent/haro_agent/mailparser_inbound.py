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

sender/sender_name are hardcoded to HARO's own address rather than extracted:
identify.py's sender check normally falls back to scanning the body for
"helpareporter.com" when the top-level sender doesn't match, but that fallback
only finds anything when a *manual* "Fwd:" compose embeds the original quoted
headers in the body. A genuine Gmail auto-forward (via a filter's "Forward it"
action, as opposed to composing a Fwd: message) does not embed those headers
at all, so that fallback finds nothing and identify() would otherwise reject
every real auto-forwarded digest. This is safe here specifically because the
Gmail filter feeding this Mailparser inbox is itself scoped to
from:(haro@helpareporter.com) - anything that reaches this inbox has already
been sender-verified upstream by Gmail's own filter.
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
        sender="haro@helpareporter.com",
        sender_name="HARO",
        subject=subject,
        received_at=received_dt,
        body=body,
    )
