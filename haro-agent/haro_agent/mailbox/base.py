"""Mailbox adapter contract. Every adapter is read-only: this codebase never
sends, replies, or archives — see spec §1, 'never send' guarantee."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List

from ..models import RawEmail


class MailboxAdapter(ABC):
    @abstractmethod
    def fetch_candidate_emails(self, lookback_hours: int) -> List[RawEmail]:
        """Return emails received within the lookback window that are plausible
        HARO candidates (final identification happens in identify.py)."""
        raise NotImplementedError
