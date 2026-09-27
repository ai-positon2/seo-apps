import pytest

from haro_agent.identify import identify
from haro_agent.mailparser_inbound import MailparserPayloadError, parse_mailparser_payload


def test_sender_is_hardcoded_to_haro_since_upstream_gmail_filter_already_verified_it():
    """Regression: a genuine Gmail auto-forward (via a filter's 'Forward it'
    action) does not embed the original quoted headers in the body the way a
    manual 'Fwd:' compose does, so identify.py's body-text sender fallback
    finds nothing and would reject every real auto-forwarded digest. Confirmed
    in production: two real auto-forwarded HARO digests both got 0 queries
    parsed because identify() rejected them on the sender check."""
    payload = {"mail_body": "1) Summary: test", "subject": "s"}
    email = parse_mailparser_payload(payload, message_id="x", received_at=None)
    assert email.sender == "haro@helpareporter.com"
    assert email.sender_name == "HARO"


def test_digest_with_index_marker_but_no_embedded_headers_is_still_identified():
    """The actual real-world shape that broke: a genuine auto-forward whose body
    has HARO's own INDEX marker but never mentions helpareporter.com anywhere,
    because there's no quoted header block like a manual Fwd: would have."""
    body = (
        "Sponsored content up top\n\n"
        "********* INDEX ***********\n\n"
        "1) Summary: test query\nRequirements: test\n"
    )
    payload = {"mail_body": body, "subject": "HARO Queries for August 24, 2026 - Evening Edition"}
    email = parse_mailparser_payload(payload, message_id="x", received_at=None)
    result = identify(email)
    assert result.is_digest


def test_parses_standard_mailparser_payload():
    payload = {"mail_body": "1) Summary: test query\nRequirements: test", "subject": "HARO Queries for August 24, 2026 - Evening Edition"}
    email = parse_mailparser_payload(payload, message_id="abc123", received_at="2026-08-24T21:00:00Z")
    assert "1) Summary: test query" in email.body
    assert email.subject == "HARO Queries for August 24, 2026 - Evening Edition"
    assert email.message_id == "abc123"
    assert email.received_at.year == 2026


def test_derives_stable_message_id_when_not_provided():
    payload = {"mail_body": "1) Summary: test query", "subject": "same subject"}
    email1 = parse_mailparser_payload(payload, message_id=None, received_at=None)
    email2 = parse_mailparser_payload(payload, message_id=None, received_at=None)
    assert email1.message_id == email2.message_id
    assert email1.message_id.startswith("mailparser:")


def test_rejects_payload_missing_mail_body():
    with pytest.raises(MailparserPayloadError):
        parse_mailparser_payload({"subject": "no body here"}, message_id="x", received_at=None)


def test_rejects_non_dict_payload():
    with pytest.raises(MailparserPayloadError):
        parse_mailparser_payload(["not", "a", "dict"], message_id="x", received_at=None)


def test_falls_back_to_now_on_unparseable_received_at():
    payload = {"mail_body": "1) Summary: test", "subject": "s"}
    email = parse_mailparser_payload(payload, message_id="x", received_at="not-a-date")
    assert email.received_at is not None
