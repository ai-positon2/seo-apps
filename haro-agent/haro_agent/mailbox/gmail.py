"""Production Gmail adapter (read-only OAuth). Not required for local testing —
see mailbox/local_fixture.py for that. Requires the optional google-api-python-client
/ google-auth-oauthlib dependencies (see requirements.txt) and a one-time OAuth
consent flow to create GMAIL_TOKEN_FILE.

Deliberately requests only the 'gmail.readonly' scope: this codebase must never be
able to send, reply, archive, or modify mail (spec §1)."""
from __future__ import annotations

import base64
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from ..emailutil import split_name_addr
from ..models import RawEmail
from .base import MailboxAdapter

READONLY_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]


class GmailMailbox(MailboxAdapter):
    def __init__(
        self,
        client_secret_file: str | None = None,
        token_file: str | None = None,
        label: str | None = None,
    ):
        self.client_secret_file = client_secret_file or os.environ.get(
            "GOOGLE_OAUTH_CLIENT_SECRET_FILE"
        )
        self.token_file = token_file or os.environ.get("GMAIL_TOKEN_FILE", "gmail_token.json")
        self.label = label or os.environ.get("GMAIL_LABEL", "HARO")
        self._service = None

    def _get_service(self):
        if self._service is not None:
            return self._service
        try:
            from google.auth.transport.requests import Request
            from google.oauth2.credentials import Credentials
            from google_auth_oauthlib.flow import InstalledAppFlow
            from googleapiclient.discovery import build
        except ImportError as exc:
            raise ImportError(
                "Gmail support requires the optional dependencies commented out in "
                "requirements.txt: google-api-python-client, google-auth-httplib2, "
                "google-auth-oauthlib. Install them to use --source gmail."
            ) from exc

        creds = None
        token_path = Path(self.token_file)
        if token_path.exists():
            creds = Credentials.from_authorized_user_file(str(token_path), READONLY_SCOPES)
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                if not self.client_secret_file:
                    raise RuntimeError(
                        "Set GOOGLE_OAUTH_CLIENT_SECRET_FILE to your OAuth client secret "
                        "JSON before running the Gmail adapter for the first time."
                    )
                flow = InstalledAppFlow.from_client_secrets_file(
                    self.client_secret_file, READONLY_SCOPES
                )
                creds = flow.run_local_server(port=0)
            token_path.write_text(creds.to_json(), encoding="utf-8")

        self._service = build("gmail", "v1", credentials=creds)
        return self._service

    def fetch_candidate_emails(self, lookback_hours: int) -> List[RawEmail]:
        service = self._get_service()
        query = f'newer_than:{max(1, lookback_hours // 24) or 1}d'
        if self.label:
            query += f" label:{self.label}"

        results = (
            service.users()
            .messages()
            .list(userId="me", q=query, maxResults=50)
            .execute()
        )
        message_ids = [m["id"] for m in results.get("messages", [])]

        emails = []
        for message_id in message_ids:
            raw = (
                service.users()
                .messages()
                .get(userId="me", id=message_id, format="full")
                .execute()
            )
            emails.append(self._to_raw_email(raw))
        return emails

    @staticmethod
    def _extract_body(payload: dict) -> str:
        if payload.get("mimeType") == "text/plain" and "data" in payload.get("body", {}):
            return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8", "replace")
        for part in payload.get("parts", []):
            body = GmailMailbox._extract_body(part)
            if body:
                return body
        return ""

    @classmethod
    def _to_raw_email(cls, raw: dict) -> RawEmail:
        headers = {h["name"].lower(): h["value"] for h in raw["payload"].get("headers", [])}
        sender_name, sender = split_name_addr(headers.get("from", ""))
        received_at = datetime.fromtimestamp(int(raw["internalDate"]) / 1000, tz=timezone.utc)
        return RawEmail(
            message_id=raw["id"],
            sender=sender,
            sender_name=sender_name,
            subject=headers.get("subject", ""),
            received_at=received_at,
            body=cls._extract_body(raw["payload"]),
        )
