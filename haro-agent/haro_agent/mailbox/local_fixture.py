"""Reads plain-text email fixtures from a local folder — used for local testing
without any mailbox credentials. Each file starts with simple 'From:'/'To:'/
'Subject:' header lines, a blank line, then the raw body (see samples/*.txt)."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from ..emailutil import split_name_addr
from ..models import RawEmail
from .base import MailboxAdapter

FROM_LINE = re.compile(r"^From:\s*(.*)$", re.IGNORECASE | re.MULTILINE)
SUBJECT_LINE = re.compile(r"^Subject:\s*(.*)$", re.IGNORECASE | re.MULTILINE)


def parse_fixture_text(text: str, message_id: str, received_at: datetime) -> RawEmail:
    header_block, _, body = text.partition("\n\n")
    from_match = FROM_LINE.search(header_block)
    subject_match = SUBJECT_LINE.search(header_block)
    sender_name, sender = split_name_addr(from_match.group(1) if from_match else "")
    subject = subject_match.group(1).strip() if subject_match else ""
    return RawEmail(
        message_id=message_id,
        sender=sender,
        sender_name=sender_name,
        subject=subject,
        received_at=received_at,
        body=body,
    )


def load_fixture_file(path: str | Path) -> RawEmail:
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
    return parse_fixture_text(text, message_id=f"local:{path.name}", received_at=mtime)


class LocalFixtureMailbox(MailboxAdapter):
    """Returns every *.txt file in samples_dir, ignoring lookback_hours — local
    fixtures are dated arbitrarily and the point is to test the pipeline
    deterministically, not to simulate real-time polling."""

    def __init__(self, samples_dir: str | Path):
        self.samples_dir = Path(samples_dir)

    def fetch_candidate_emails(self, lookback_hours: int) -> List[RawEmail]:
        if not self.samples_dir.exists():
            return []
        files = sorted(self.samples_dir.glob("*.txt"))
        return [load_fixture_file(f) for f in files]
