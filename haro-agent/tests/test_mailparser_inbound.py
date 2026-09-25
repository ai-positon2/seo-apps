import pytest

from haro_agent.mailparser_inbound import MailparserPayloadError, parse_mailparser_payload


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
