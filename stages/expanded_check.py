def build_prompt(base_content: str, expanded_content: str, post_type: str, location: str) -> str:
    base_chars = len(base_content)
    expanded_chars = len(expanded_content)

    return f"""Review this location-specific (expanded) GBP post against the approved base content and the client's brand guidelines.

## Post Details
- Post Type: {post_type}
- Location: {location}
- Base Content Length: {base_chars} chars
- Expanded Content Length: {expanded_chars} chars

## Approved Base Content
---
{base_content}
---

## Expanded / Location-Specific Content to Review
---
{expanded_content}
---

## Checklist — Verify Every Item Against the Client Guidelines Provided
1. Base Content Fidelity — Does the expanded post follow the approved base content without unauthorized deviations in messaging or facts?
2. Location Name — Based on the client's location rules for this post type and location: should the location name appear in the post? Is it correctly included or correctly omitted?
3. Service Availability Note — Is the correct service-availability note present if this location does not offer the service for this post type?
4. Location-Specific Rules — Are all location-specific rules from the client guidelines applied correctly? (e.g., Sacramento online services mention, TMS availability by location, addiction/mental health/teen service availability by location)
5. Character Count — Is the expanded post within the client's character limit? (current: {expanded_chars} chars)
6. Tone & Voice — Does the tone match the client's brand tone guidelines?
7. CTA Consistency — Is the CTA present and consistent with the approved base content?
8. Link Presence — Is a relevant link included per the client's link rules?
9. Writing Style — Does the post follow all client writing style rules? (AP Style, terminology, bullet point casing, word choices)
10. Special Rules Compliance — Check every special rule in the client guidelines (terminology, spelling, factual accuracy, treatment-specific rules)
11. Meaningful Customization — Has the post been meaningfully adapted for the location without over-editing or departing from approved messaging?
12. Formatting & Readability — Is the post well-structured and readable?
13. Overall Brand Compliance — Does the expanded post follow all client brand guidelines?

## Output Rules
- If any issues are found: ALWAYS provide a complete suggested_edited_version with every issue corrected.
- If no issues are found: leave suggested_edited_version as an empty string.

Return your structured JSON result only."""
