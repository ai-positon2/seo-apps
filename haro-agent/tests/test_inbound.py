import pytest

from haro_agent.inbound import InboundPayloadError, parse_cloudmailin_payload


def _payload(**overrides):
    base = {
        "headers": {
            "from": "HARO <replies@helpareporter.com>",
            "to": "HARO Agent <abc123@cloudmailin.net>",
            "subject": "HARO Queries for August 24, 2026 - Evening Edition",
            "message_id": "<4F145791.8040802@helpareporter.com>",
            "date": "Mon, 24 Aug 2026 21:00:00 +0000",
        },
        "envelope": {
            "to": "abc123@cloudmailin.net",
            "from": "replies@helpareporter.com",
            "recipients": ["abc123@cloudmailin.net"],
        },
        "plain": "1) Summary: test query\nRequirements: test",
        "html": "<html><body>1) Summary: test query</body></html>",
        "attachments": [],
    }
    base.update(overrides)
    return base


def test_parses_standard_cloudmailin_payload():
    email = parse_cloudmailin_payload(_payload())
    assert email.sender == "replies@helpareporter.com"
    assert email.sender_name == "HARO"
    assert email.subject == "HARO Queries for August 24, 2026 - Evening Edition"
    assert email.message_id == "4F145791.8040802@helpareporter.com"
    assert "1) Summary: test query" in email.body


def test_falls_back_to_html_when_plain_is_missing():
    payload = _payload(plain=None, html="<p>1) Summary: html only</p>")
    email = parse_cloudmailin_payload(payload)
    assert "1) Summary: html only" in email.body
    assert "<p>" not in email.body


def test_derives_stable_message_id_when_header_missing():
    payload = _payload()
    del payload["headers"]["message_id"]
    email1 = parse_cloudmailin_payload(payload)
    email2 = parse_cloudmailin_payload(payload)
    assert email1.message_id == email2.message_id
    assert email1.message_id.startswith("cloudmailin:")


def test_falls_back_to_envelope_from_when_headers_missing():
    payload = _payload(headers={"subject": "no from header"})
    email = parse_cloudmailin_payload(payload)
    assert email.sender == "replies@helpareporter.com"


def test_rejects_non_dict_payload():
    with pytest.raises(InboundPayloadError):
        parse_cloudmailin_payload(["not", "a", "dict"])
