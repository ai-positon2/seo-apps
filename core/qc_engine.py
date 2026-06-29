import json
import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

MODEL          = "gpt-4o-mini"  # stages 1 & 2
GENERATE_MODEL = "gpt-4o-mini"  # stage 3 — location content generation


class QCEngine:
    def __init__(self, client_guidelines: dict):
        self.guidelines = client_guidelines
        self._client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

    def _system_prompt(self) -> str:
        guidelines_json = json.dumps(self.guidelines, indent=2)
        return f"""You are a precise GBP (Google Business Profile) Quality Check Agent for {self.guidelines['client_name']}.

Your task is to review GBP post content against the brand guidelines below and return a structured JSON result.

## Client Brand Guidelines
```json
{guidelines_json}
```

## Scoring
- 90-100 -> Overall Status: "Pass"
- 70-89  -> Overall Status: "Needs Minor Edits"
- 0-69   -> Overall Status: "Needs Major Edits"

## Critical Rules for Flagging Issues
- ONLY flag genuine, clear violations of explicit rules stated in the guidelines.
- Examples in the guidelines (cta_examples, approved_safe_phrases, etc.) are illustrations of acceptable style — they are NOT exact required phrases. Never flag content simply because it uses different wording than an example.
- CTA check: A CTA PASSES if it is (1) present at the end of the post, (2) clear and action-oriented, and (3) uses the correct brand name where the guidelines require it. Synonyms like "book an appointment", "schedule a visit", "make an appointment", "call us today" are all equally valid CTAs.
- Do NOT flag phrasing preferences or stylistic differences. Only flag actual rule violations.
- For every issue you flag, you MUST cite the specific rule or guideline being violated in the "reason" field.
- If you are uncertain whether something is a genuine violation, do NOT flag it.
- A post with a clear CTA, correct brand name, correct character count, and no banned phrases should score very high even if phrasing differs from the examples.

## Response Format
Respond ONLY with a valid JSON object — no markdown fences, no extra text:
{{
  "overall_status": "Pass" | "Needs Minor Edits" | "Needs Major Edits",
  "qc_score": <integer 0-100>,
  "passed_checks": ["<specific check that passed>"],
  "issues_found": [
    {{
      "severity": "major" | "minor",
      "check": "<check category>",
      "issue": "<specific description of the violation>",
      "reason": "<the exact rule or guideline being violated — quote it directly>"
    }}
  ],
  "recommended_fixes": ["<specific actionable fix>"],
  "suggested_edited_version": "<complete corrected post if fixes are needed, otherwise empty string>",
  "final_approval_recommendation": "<one clear paragraph stating whether to approve, reject, or revise>"
}}"""

    def check_base_content(self, topic: str, content: str, post_type: str, location: str = "") -> dict:
        from stages.base_check import build_prompt
        return self._run(build_prompt(topic, content, post_type, location))

    def check_expanded_content(self, base_content: str, expanded_content: str, post_type: str, location: str) -> dict:
        from stages.expanded_check import build_prompt
        return self._run(build_prompt(base_content, expanded_content, post_type, location))

    def check_published_post(self, published_content: str, approved_content: str, post_type: str, location: str) -> dict:
        from stages.published_check import build_prompt
        return self._run(build_prompt(published_content, approved_content, post_type, location))

    def generate_location_content(self, base_content: str, location: str, post_type: str) -> dict:
        from stages.content_generator import build_prompt, fetch_location_context
        location_context = fetch_location_context(location, self.guidelines)
        result = self._run_generate(build_prompt(base_content, location, post_type, location_context, self.guidelines))
        # Overwrite model's self-reported count with Python's own len() — the source of truth
        full_post = result.get("full_post", "")
        result["character_count"] = len(full_post)
        result["within_limit"] = len(full_post) <= 1500
        return result

    def _run(self, user_prompt: str) -> dict:
        return self._call(MODEL, temperature=0, user_prompt=user_prompt)

    def _run_generate(self, user_prompt: str) -> dict:
        return self._call(GENERATE_MODEL, temperature=0.35, user_prompt=user_prompt)

    def _call(self, model: str, temperature: float, user_prompt: str) -> dict:
        response = self._client.chat.completions.create(
            model=model,
            max_tokens=2048,
            temperature=temperature,
            messages=[
                {"role": "system", "content": self._system_prompt()},
                {"role": "user", "content": user_prompt},
            ],
            response_format={"type": "json_object"},
        )

        raw = response.choices[0].message.content.strip()

        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            return {
                "overall_status": "Error",
                "qc_score": 0,
                "passed_checks": [],
                "issues_found": [{
                    "severity": "major",
                    "check": "System Error",
                    "issue": f"Failed to parse QC result: {e}"
                }],
                "recommended_fixes": ["Please try again. If the problem persists, check your API key."],
                "suggested_edited_version": "",
                "final_approval_recommendation": f"QC check failed due to a parsing error. Raw response snippet: {raw[:300]}",
            }
