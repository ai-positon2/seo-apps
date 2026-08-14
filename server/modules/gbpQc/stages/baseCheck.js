function buildPrompt(topic, content, postType, location = '') {
  const charCount = content.length;

  return `Review the following BASE GBP post content against the client's brand guidelines.

IMPORTANT CONTEXT: This is BASE content — a general template that will be customized for each location separately. Do NOT flag missing location names or service-availability notes. Those are checked in the Expanded Content QC stage.

## Post Details
- Approved Topic: ${topic}
- Post Type: ${postType}
- Character Count: ${charCount}

## Base Content to Review
---
${content}
---

## Checklist — Verify Every Item Against the Client Guidelines Provided
1. Topic Alignment — Does the post clearly address the approved topic?
2. Topic Restrictions — Does the topic or content violate any client-specific restrictions (banned words, banned topics, restricted content)?
3. Tone & Voice — Does the tone match the client's specified brand tone?
4. Character Count — Is the post within the client's character limit? (current: ${charCount} chars)
5. Link Presence — Is a relevant link included per the client's link rules?
6. CTA Presence — Is at least one call-to-action present as required?
7. Writing Style — Does the post follow all client writing style rules? (AP Style, terminology preferences, bullet point formatting, word substitutions, etc.)
8. Post-Type Specific Rules — If the post type has specific restrictions or requirements in the guidelines (e.g., teen topic lists, TMS accuracy rules, condition inclusions), are they correctly followed?
9. Special Rules Compliance — Check every special rule listed in the client guidelines (terminology, spelling, factual accuracy for specific treatments or services)
10. Formatting & Readability — Is the post well-structured, clear, and easy to read?
11. Overall Brand Compliance — Does the post follow all guidelines for this client?

## Output Rules
- If any issues are found: ALWAYS provide a complete suggested_edited_version with every issue corrected.
- If no issues are found: leave suggested_edited_version as an empty string.
- Do NOT flag missing location names or service-availability notes — those belong in the Expanded Content QC stage.

Return your structured JSON result only.`;
}

module.exports = { buildPrompt };
