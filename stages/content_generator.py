import re
import time
import requests
from bs4 import BeautifulSoup


# ── Location page fetcher ────────────────────────────────────────────────────

def _slug(text: str) -> str:
    """Convert a location display name to a URL-friendly slug."""
    text = text.lower()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"\s+", "-", text.strip())
    return text


def fetch_location_context(location: str, guidelines: dict) -> str:
    """
    Try to fetch the brand's location page and extract useful copy.
    Returns a short context string (max ~400 chars) or empty string if unavailable.
    """
    template = guidelines.get("location_page_url_template", "")
    if not template:
        return ""

    try:
        # Build the slug from just the city part of the location display name
        # e.g. "Gentle Dental in Arlington" -> "arlington"
        # e.g. "Great Lakes Family Dental in Howell, MI" -> "howell-mi"
        loc_part = location
        brand_fmt = guidelines.get("brand_name_with_location_format", "")
        if brand_fmt and "[Location]" in brand_fmt:
            prefix = brand_fmt.split("[Location]")[0].strip().lower()
            loc_lower = location.lower()
            if loc_lower.startswith(prefix):
                loc_part = location[len(brand_fmt.split("[Location]")[0]):].strip()

        slug = _slug(loc_part)
        url  = template.replace("{slug}", slug)

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        }
        resp = requests.get(url, headers=headers, timeout=6)
        if resp.status_code != 200:
            return ""

        soup = BeautifulSoup(resp.text, "html.parser")

        # Remove nav, footer, scripts, styles
        for tag in soup(["script", "style", "nav", "footer", "header", "aside"]):
            tag.decompose()

        # Grab main content text
        main = soup.find("main") or soup.find("article") or soup.body
        if not main:
            return ""

        text = main.get_text(separator=" ", strip=True)
        # Collapse whitespace
        text = re.sub(r"\s{2,}", " ", text)
        # Keep only the first 500 chars as context
        return text[:500].strip()

    except Exception:
        return ""


# ── Location requirements extractor ─────────────────────────────────────────

def _build_location_requirements(location: str, post_type: str, guidelines: dict) -> str:
    """
    Returns a formatted requirements block to inject into the generation prompt.
    Reads from location_rules map (new) or post_types data (fallback).
    Always injects applicable special_rules.
    """
    lines = []
    loc_lower = location.lower()
    pt_lower = post_type.lower()

    # ── Special rules ─────────────────────────────────────────────────────────
    mandatory = []
    for rule in guidelines.get("special_rules", []):
        rule_id  = rule.get("id", "")
        rule_txt = rule.get("rule", "")
        chk_txt  = rule.get("check", "")

        if rule_id == "dbt_spelling":
            # Always include — applies whenever DBT is mentioned
            mandatory.append(f"CRITICAL SPELLING: {rule_txt}\n   → {chk_txt}")
        else:
            # Include only when the location name matches
            keywords = [w for w in re.split(r"[_\s]", rule_id) if len(w) > 3]
            if any(kw in loc_lower for kw in keywords):
                mandatory.append(f"Location Rule: {rule_txt}\n   → {chk_txt}")

    if mandatory:
        lines.append("## Mandatory Rules for This Location & Content")
        for m in mandatory:
            lines.append(f"- {m}")
        lines.append("")

    # ── Service availability — from explicit location_rules map ───────────────
    location_rules = guidelines.get("location_rules", {})
    if location in location_rules:
        loc_cfg = location_rules[location]
        available = loc_cfg.get("services", [])
        svc_notes = loc_cfg.get("service_notes", {})

        # Find which service bucket this post_type falls into
        matched_svc = None
        for svc in ["mental_health", "addiction", "teen"]:
            if svc.replace("_", " ") in pt_lower or pt_lower in svc.replace("_", " "):
                matched_svc = svc
                break
        if not matched_svc:
            for svc in ["awareness", "general", "holiday"]:
                if svc in pt_lower:
                    matched_svc = svc
                    break

        if matched_svc and matched_svc not in available and svc_notes.get(matched_svc):
            note = svc_notes[matched_svc]
            lines.append("## Service Availability Note — REQUIRED")
            lines.append(f"This location does NOT offer {matched_svc.replace('_', ' ')} services.")
            lines.append("Append this EXACT note at the very end of the post body (and full_post):")
            lines.append(f'"{note}"')
            lines.append("")
        elif matched_svc and matched_svc in available:
            lines.append(f"## Service Availability")
            lines.append(f"This location DOES offer {matched_svc.replace('_', ' ')} — no service note needed.")
            lines.append("")

    return "\n".join(lines)


# ── Prompt builder ───────────────────────────────────────────────────────────

def build_prompt(base_content: str, location: str, post_type: str,
                 location_context: str = "", guidelines: dict = None) -> str:
    base_chars = len(base_content)
    guidelines = guidelines or {}

    # Pull banned phrases from client guidelines, fall back to generic list
    banned = (guidelines.get("clinical_language_rules") or {}).get(
        "banned_phrases",
        ["guaranteed results", "the best", "number one", "perfect results guaranteed"]
    )
    banned_str = ", ".join(f'"{p}"' for p in banned)

    context_section = ""
    if location_context:
        context_section = f"""
## Location Page Context (scraped from the brand's website for this location)
Use the following snippet to inform subtle, natural phrasing tweaks — e.g. referencing a specific service,
a local detail, or a phrase that matches this location's page tone. Do NOT quote it verbatim; weave it in naturally.
---
{location_context[:400]}
---
"""

    location_requirements = _build_location_requirements(location, post_type, guidelines)
    requirements_section = f"\n{location_requirements}\n" if location_requirements else ""

    return f"""Generate a complete, ready-to-post location-specific GBP post for the location below.

{requirements_section}## PRIMARY RULE — Base Content is the Hard Template
The approved base content below is the exact structural template you must follow.
- Mirror its sections, order, and length exactly — do NOT add sections that are not present in the base content.
- Do NOT add a "Why Choose" section (or any other section) if it does not appear in the base content.
- Do NOT remove sections that are present in the base content.
- If the base content has 4 sections, the output has 4 sections. If it has 6, the output has 6.
- The user has intentionally written the base content this way — treat it as a hard rule, not a suggestion.
{context_section}
## Your Only Job
Swap in the correct location name throughout, and make subtle natural rephrasing so each location's
post feels individually written rather than copy-pasted:
- Vary sentence structure in the intro (reorder clauses, vary sentence length)
- Vary word choice in 1–2 sentences (synonyms, different openers — same meaning)
- Vary the phrasing of 1–2 bullet points if bullet points are present (same facts, different wording)
- Vary the CTA sentence slightly (same call to action, slightly different phrasing)

Do NOT invent new facts, services, claims, or sections not present in the base content.

## Location
{location}

## Post Type / Theme
{post_type}

## Approved Base Content — FOLLOW THIS STRUCTURE EXACTLY
---
{base_content}
---
Base content length: {base_chars} characters

## Style Rules (apply only within the structure above)

### Brand Name
- Use the exact brand name format from the guidelines (e.g. "Gentle Dental in [Location]")
- Substitute the correct location name everywhere the placeholder appears
- Do not shorten or alter the brand name

### Title
- Keep the same title structure as the base content
- Substitute the correct location name — never start the title with the brand name

### CTA
- Keep whatever CTA style is in the base content
- Substitute the correct location name
- Do not add a phone number

### Tone
- Warm, helpful, patient-first, simple, reassuring
- Do not use: {banned_str}

### Character Count
- Stay within 1500 characters total
- Aim to match the base content length closely: {base_chars} characters

## Output Format
Return ONLY a valid JSON object — no markdown fences, no extra text:
{{
  "title": "<the complete post title>",
  "body": "<the post body — everything after the title, ready to paste>",
  "full_post": "<title + two newlines + body, exactly as it should appear when posted>",
  "character_count": <integer: total character count of full_post>,
  "within_limit": <true if character_count <= 1500>,
  "sections_included": ["<list only the sections actually present in the output>"],
  "customization_notes": ["<brief note on what was rephrased or tweaked specifically for this location>"]
}}"""
