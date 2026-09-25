"""Spec §9: JSON-file state store — processed_emails, reported_matches,
parse_failures, pitch_log. Also implements the idempotency/duplicate rules from §2/§6."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional, Set, Tuple

MAX_INBOX_LOG_ENTRIES = 20


class StateStore:
    def __init__(self, state_dir: str | Path):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self._processed_emails_path = self.state_dir / "processed_emails.json"
        self._reported_matches_path = self.state_dir / "reported_matches.json"
        self._parse_failures_path = self.state_dir / "parse_failures.json"
        self._pitch_log_path = self.state_dir / "pitch_log.json"
        self._inbox_log_path = self.state_dir / "inbox_log.json"

        self.processed_emails: dict = self._load(self._processed_emails_path, {})
        self.reported_matches: List[dict] = self._load(self._reported_matches_path, [])
        self.parse_failures: List[dict] = self._load(self._parse_failures_path, [])
        self.pitch_log: List[dict] = self._load(self._pitch_log_path, [])
        self.inbox_log: List[dict] = self._load(self._inbox_log_path, [])

    @staticmethod
    def _load(path: Path, default):
        if not path.exists():
            return default
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)

    def _dump(self, path: Path, data) -> None:
        with path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)

    def is_email_processed(self, message_id: str) -> bool:
        return message_id in self.processed_emails

    def mark_email_processed(
        self, message_id: str, digest_date: str, edition: str, query_count: int, timestamp: str
    ) -> None:
        self.processed_emails[message_id] = {
            "digest_date": digest_date,
            "edition": edition,
            "query_count": query_count,
            "processed_at": timestamp,
        }

    def already_reported_ids(self) -> Set[Tuple[str, str]]:
        return {(m["profile_id"], m["query_id"]) for m in self.reported_matches}

    def record_match(
        self, query_id: str, profile_id: str, score: int, reported_at: str, action_taken: str
    ) -> None:
        self.reported_matches.append(
            {
                "query_id": query_id,
                "profile_id": profile_id,
                "score": score,
                "reported_at": reported_at,
                "action_taken": action_taken,
            }
        )

    def record_parse_failure(self, digest_reference: str, error: str, raw_block: str) -> None:
        self.parse_failures.append(
            {"digest_reference": digest_reference, "error": error, "raw_block": raw_block}
        )

    def record_pitch(
        self,
        query_id: str,
        draft: str,
        sent: bool = False,
        placement_result: Optional[str] = None,
    ) -> None:
        self.pitch_log.append(
            {
                "query_id": query_id,
                "draft": draft,
                "sent": sent,
                "placement_result": placement_result,
            }
        )

    def record_inbox_email(
        self, message_id: str, sender: str, subject: str, received_at: str, body: str
    ) -> None:
        """Keeps the last MAX_INBOX_LOG_ENTRIES raw inbound emails (subject/sender/
        body) so the password-protected dashboard's /inbox page can show real
        content CloudMailin delivered - e.g. to read a code out of a Gmail
        forwarding-confirmation email, since CloudMailin's own dashboard only
        shows delivery status, never message content."""
        self.inbox_log.append(
            {
                "message_id": message_id,
                "sender": sender,
                "subject": subject,
                "received_at": received_at,
                "body": body,
            }
        )
        self.inbox_log = self.inbox_log[-MAX_INBOX_LOG_ENTRIES:]

    def save(self) -> None:
        self._dump(self._processed_emails_path, self.processed_emails)
        self._dump(self._reported_matches_path, self.reported_matches)
        self._dump(self._parse_failures_path, self.parse_failures)
        self._dump(self._pitch_log_path, self.pitch_log)
        self._dump(self._inbox_log_path, self.inbox_log)
