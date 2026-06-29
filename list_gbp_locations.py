"""
Run this script to list all GBP accounts and their locations.
Copy the location IDs into your client JSON files.

Usage:
    python list_gbp_locations.py
"""

import os
import pickle
import sys
from pathlib import Path
from googleapiclient.discovery import build
from google.auth.transport.requests import Request

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

TOKEN_FILE = Path(__file__).parent / "token.pkl"

try:
    if not TOKEN_FILE.exists():
        print("ERROR: token.pkl not found. Run auth_gbp.py first.")
        input("\nPress Enter to close...")
        sys.exit(1)

    with open(TOKEN_FILE, "rb") as f:
        creds = pickle.load(f)

    # Refresh token if expired
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        with open(TOKEN_FILE, "wb") as f:
            pickle.dump(creds, f)

    # ── List accounts ─────────────────────────────────────────────────────────
    acct_service = build("mybusinessaccountmanagement", "v1", credentials=creds)
    accounts     = acct_service.accounts().list().execute().get("accounts", [])

    if not accounts:
        print("No accounts found. Make sure the authenticated Google account manages GBP listings.")
        input("\nPress Enter to close...")
        sys.exit(1)

    print(f"\nFound {len(accounts)} account(s):\n")

    for account in accounts:
        account_id   = account["name"]
        account_name = account.get("accountName", "Unknown")
        print(f"  Account: {account_name}")
        print(f"  ID:      {account_id}")
        print()

        # ── List locations for this account ──────────────────────────────────
        loc_service = build("mybusinessbusinessinformation", "v1", credentials=creds)
        try:
            locs = loc_service.accounts().locations().list(
                parent=account_id,
                readMask="name,title,storefrontAddress"
            ).execute().get("locations", [])
        except Exception as e:
            print(f"  Could not list locations: {e}\n")
            continue

        if not locs:
            print("  No locations found for this account.\n")
            continue

        print(f"  Locations ({len(locs)} total):")
        print(f"  {'Location Name':<50} {'Location ID'}")
        print(f"  {'-'*50} {'-'*30}")

        for loc in locs:
            name   = loc.get("title", "Unknown")
            loc_id = loc["name"]
            addr   = loc.get("storefrontAddress", {})
            city   = addr.get("locality", "")
            state  = addr.get("administrativeArea", "")
            label  = f"{name} ({city}, {state})" if city else name
            print(f"  {label:<50} {loc_id}")

        print()

    print("Copy the location IDs above into your client JSON files under 'location_ids'.")
    print('Format: "Gentle Dental in Arlington": "locations/987654321"')

except Exception as e:
    print(f"\n ERROR: {e}")

input("\nPress Enter to close...")
