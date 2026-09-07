"""Small shared helpers for turning raw email header text into structured fields.
Used by every RawEmail source (local fixtures, Gmail, the inbound-email webhook)."""
from __future__ import annotations

import re

NAME_ADDR = re.compile(r"^(.*?)<([^<>]+)>\s*$")


def split_name_addr(from_value: str) -> tuple[str, str]:
    """'Display Name <addr@example.com>' -> ('Display Name', 'addr@example.com').
    A bare address (no angle brackets) returns ('', address)."""
    from_value = (from_value or "").strip()
    match = NAME_ADDR.match(from_value)
    if match:
        return match.group(1).strip().strip('"'), match.group(2).strip()
    return "", from_value
