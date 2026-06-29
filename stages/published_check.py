def build_prompt(published_content: str, approved_content: str, post_type: str, location: str) -> str:
    published_chars = len(published_content)
    approved_chars = len(approved_content)

    return f"""Review this published GBP post against the approved final content and brand guidelines.

## Post Details
- Post Type: {post_type}
- Expected Location: {location}
- Approved Content Character Count: {approved_chars}
- Published Content Character Count: {published_chars} (limit: 1500)

## Approved Final Content
---
{approved_content}
---

## Published Content (as it appears live)
---
{published_content}
---

## Checklist — Verify Each Item
1. Content Match — Does the published post match the approved final content? Flag any unauthorized deviations, missing sentences, or added text.
2. Location Accuracy — Is the correct location name present (or correctly absent for Online/general posts)?
3. Wrong Location — Is any incorrect location name accidentally included?
4. Service Availability Note — Is the required service-availability note present and worded correctly?
5. CTA Presence — Is the call-to-action present and correct?
6. Link Presence — Is the relevant link included and pointing to clearbehavioralhealth.com?
7. Character Count — Is the published post under 1500 characters? (current: {published_chars})
8. Missing Text — Is any text from the approved version missing in the published version?
9. Formatting Errors — Are there any visible formatting issues, broken text, or display problems?
10. DBT Spelling — If DBT is mentioned, is it spelled "Dialectical Behavior Therapy" (not "Behavioral")?
11. Factual Accuracy — Are any facts, service names, or location details incorrect?
12. Inconsistent Messaging — Does any part of the published post conflict with the approved version or brand guidelines?
13. Overall Brand Compliance — Does the published post comply with all YBH/Clear Behavioral Health brand guidelines?

Return your structured JSON result only."""
