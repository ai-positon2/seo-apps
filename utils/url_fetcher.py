import os
import requests
from bs4 import BeautifulSoup

try:
    from apify_client import ApifyClient
    APIFY_AVAILABLE = True
except ImportError:
    APIFY_AVAILABLE = False

# Google-owned domains that require login to see GBP post content
GBP_DOMAINS = (
    "business.google.com",
    "maps.app.goo.gl",
    "goo.gl",
    "g.co",
)

# Minimum meaningful content length — anything below this is just the login wall
MIN_CONTENT_LENGTH = 200


class URLFetcher:
    HEADERS = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        )
    }

    def is_gbp_dashboard_url(self, url: str) -> bool:
        return any(domain in url for domain in GBP_DOMAINS)

    def fetch(self, url: str) -> tuple:
        """
        Returns (content: str | None, method: str).
        Tries Apify if configured, falls back to requests.
        Returns (None, 'login_required') for GBP dashboard URLs that need auth.
        """
        if not url or not url.startswith("http"):
            return None, "invalid_url"

        apify_token = os.environ.get("APIFY_API_TOKEN", "")
        has_apify = APIFY_AVAILABLE and apify_token and apify_token not in ("your_apify_token_here", "")

        if has_apify:
            content = self._apify_fetch(url, apify_token)
            if content and len(content) >= MIN_CONTENT_LENGTH:
                return content, "apify"
            elif content and len(content) < MIN_CONTENT_LENGTH:
                # Got something but too short — likely a login wall
                return None, "login_required"

        # Fallback: standard HTTP request
        content = self._requests_fetch(url)
        if content and len(content) >= MIN_CONTENT_LENGTH:
            return content, "requests"

        return None, "login_required"

    def _apify_fetch(self, url: str, token: str) -> str | None:
        try:
            client = ApifyClient(token)
            run = client.actor("apify/website-content-crawler").call(run_input={
                "startUrls": [{"url": url}],
                "maxCrawlPages": 1,
                "crawlerType": "playwright:firefox",
                "maxCrawlDepth": 0,
            })
            items = list(client.dataset(run.default_dataset_id).iterate_items())
            if items:
                item = items[0]
                return item.get("text") or item.get("markdown") or item.get("html") or ""
            return None
        except Exception:
            return None

    def _requests_fetch(self, url: str) -> str | None:
        try:
            response = requests.get(url, headers=self.HEADERS, timeout=15)
            response.raise_for_status()
            soup = BeautifulSoup(response.text, "html.parser")
            for tag in soup(["script", "style", "nav", "footer", "header", "meta", "link"]):
                tag.decompose()
            text = soup.get_text(separator="\n", strip=True)
            lines = [line.strip() for line in text.splitlines() if line.strip()]
            return "\n".join(lines)
        except Exception:
            return None
