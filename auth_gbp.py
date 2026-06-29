"""
Run this script ONCE to authenticate with Google and save your token.
After this, the app uses token.pkl automatically and refreshes it as needed.

Usage:
    python auth_gbp.py
"""

import os
import pickle
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"

SCOPES = ["https://www.googleapis.com/auth/business.manage"]
CREDENTIALS_FILE = Path(__file__).parent / "credentials.json"
TOKEN_FILE        = Path(__file__).parent / "token.pkl"

if not CREDENTIALS_FILE.exists():
    print("ERROR: credentials.json not found.")
    print("Download it from Google Cloud Console → APIs & Services → Credentials.")
    exit(1)

flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
flow.redirect_uri = "http://localhost"

# Generate the auth URL manually so you can paste it into Chrome yourself
auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
print("\nCopy and paste this URL into Chrome:\n")
print(auth_url)
print("\n" + "-"*60)
print("After signing in and clicking Allow, Chrome will show")
print("a page that says 'This site can't be reached' -- that is NORMAL.")
print("Copy the FULL URL from Chrome's address bar and paste it below.")
print("-"*60 + "\n")
redirect_response = input("Paste the redirect URL here: ").strip()

try:
    flow.fetch_token(authorization_response=redirect_response)
    creds = flow.credentials

    with open(TOKEN_FILE, "wb") as f:
        pickle.dump(creds, f)

    print(f"\n✓ Authentication complete. Token saved to: {TOKEN_FILE}")
    print("You do not need to run this again unless you revoke access.")
except Exception as e:
    print(f"\n ERROR: {e}")
    print("\nMake sure you copied the FULL URL from Chrome's address bar,")
    print("including everything after the '?' (the code=... part).")

input("\nPress Enter to close...")
