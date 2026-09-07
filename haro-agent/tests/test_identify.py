from pathlib import Path

from haro_agent.identify import identify
from haro_agent.mailbox.local_fixture import load_fixture_file
from haro_agent.models import RawEmail

SAMPLES_DIR = Path(__file__).resolve().parent.parent / "samples"


def test_normal_digest_is_identified():
    email = load_fixture_file(SAMPLES_DIR / "digest_evening_normal.txt")
    result = identify(email)
    assert result.is_digest
    assert "summary_blocks" in result.reason


def test_forwarded_digest_is_identified_via_body_sender():
    email = load_fixture_file(SAMPLES_DIR / "digest_forwarded_malformed.txt")
    result = identify(email)
    assert result.is_digest


def test_no_ai_pitch_digest_is_identified():
    email = load_fixture_file(SAMPLES_DIR / "digest_no_ai_pitch.txt")
    result = identify(email)
    assert result.is_digest


def test_marketing_email_is_skipped_as_non_digest():
    email = RawEmail(
        message_id="marketing-1",
        sender="news@helpareporter.com",
        sender_name="HARO",
        subject="Prefer less email? Update your preferences",
        received_at=None,
        body="We noticed you haven't opened HARO in a while. Update your preferences here.",
    )
    result = identify(email)
    assert not result.is_digest
    assert result.reason == "skipped_non_digest"


def test_unrelated_email_fails_sender_check():
    email = RawEmail(
        message_id="unrelated-1",
        sender="notifications@github.com",
        sender_name="GitHub",
        subject="Your pull request was merged",
        received_at=None,
        body="1) Summary: not actually HARO\n2) Summary: still not HARO\n3) Summary: nope",
    )
    result = identify(email)
    assert not result.is_digest
    assert result.reason == "sender_check_failed"
