# LOCATION + SERVICE PAGE TEMPLATE

## PURPOSE

Use this framework to generate SEO content briefs and/or content for:

{{SERVICE_NAME}} in {{LOCATION_NAME}}

This is a reusable Location + Service page template.

The same framework must work across different:
- Services
- Conditions
- Treatments
- Locations
- Brands

Do not hard-code page-specific information.

All page-specific information must come from supplied data, keyword research, competitor research, or verified client information.

==================================================
# 1. PAGE INPUT VARIABLES
==================================================

BRAND_NAME:
{{BRAND_NAME}}

DOMAIN:
{{DOMAIN}}

SERVICE_NAME:
{{SERVICE_NAME}}

SERVICE_NAME_LOWERCASE:
{{SERVICE_NAME_LOWERCASE}}

LOCATION_NAME:
{{LOCATION_NAME}}

CITY:
{{CITY}}

STATE:
{{STATE}}

STATE_ABBREVIATION:
{{STATE_ABBREVIATION}}

LOCATION_SLUG:
{{LOCATION_SLUG}}

SERVICE_SLUG:
{{SERVICE_SLUG}}

LOCATION_ADDRESS:
{{LOCATION_ADDRESS}}

PHONE_NUMBER:
{{PHONE_NUMBER}}

SERVING_AREAS:
{{SERVING_AREAS}}

AGES_SERVED:
{{AGES_SERVED}}

MAP_DATA:
{{MAP_DATA}}

PRIMARY_KEYWORD_1:
{{PRIMARY_KEYWORD_1}}

PRIMARY_KEYWORD_2:
{{PRIMARY_KEYWORD_2}}

PRIMARY_KEYWORDS:
{{PRIMARY_KEYWORDS}}

SECONDARY_KEYWORDS:
{{SECONDARY_KEYWORDS}}

COMPETITOR_URLS:
{{COMPETITOR_URLS}}

COMPETITOR_PAGE_CONTENT:
{{COMPETITOR_PAGE_CONTENT}}

FAQ_DATA:
{{FAQ_DATA}}

CLIENT_VERIFIED_INFORMATION:
{{CLIENT_VERIFIED_INFORMATION}}

==================================================
# 2. SEO URL
==================================================

## Suggested URL

Recommended structure:

{{DOMAIN}}/locations/{{LOCATION_SLUG}}/{{SERVICE_SLUG}}

Example structure only:

domain.com/locations/location-name/service-name

Do not use example values on live pages.

The URL should:
- Clearly represent the location.
- Clearly represent the service.
- Be concise.
- Use lowercase formatting.
- Use hyphens between words.
- Avoid unnecessary folders or parameters.

==================================================
# 3. SEO TITLE
==================================================

Recommended general structure:

{{SERVICE_NAME}} in {{LOCATION_NAME}} | {{BRAND_NAME}}

However, the final title should be based on keyword targeting and natural readability.

## Primary Keyword Requirement

The SEO title should include:

{{PRIMARY_KEYWORD_1}}

Use the main primary keyword naturally.

If the exact keyword does not read naturally, use a close variant of the primary keyword.

Examples of acceptable adjustments:

Exact keyword:
anxiety treatment anaheim hills

Natural variation:
Anxiety Treatment in Anaheim Hills

Exact keyword:
depression treatment center torrance

Natural variation:
Depression Treatment Center in Torrance

Do not force-fit an exact keyword if it creates unnatural language.

## Rules

- Include the main primary keyword or a close natural variant.
- Include location intent.
- Include the brand when appropriate.
- Target approximately 50 to 60 characters where practical.
- Prioritize readability over exact-match keyword usage.
- Do not keyword-stuff.
- Do not repeat similar primary keywords.

==================================================
# 4. META DESCRIPTION
==================================================

Create a unique meta description for the specific Location + Service page.

## Primary Keyword Requirement

At minimum, naturally incorporate:

{{PRIMARY_KEYWORD_1}}

Ideally, incorporate both:

{{PRIMARY_KEYWORD_1}}
{{PRIMARY_KEYWORD_2}}

However:

If both primary keywords are extremely similar, do not repeat the same concept unnecessarily.

Example:

Primary Keyword 1:
anxiety treatment anaheim hills

Primary Keyword 2:
anxiety treatment in anaheim hills

Do NOT write both phrases separately just to satisfy keyword usage.

Instead, use one natural variation such as:

"Explore anxiety treatment in Anaheim Hills..."

## Close Variants

Close variants of primary keywords are acceptable when they improve readability.

Do not force exact-match keywords into unnatural sentences.

## Requirements

- Target approximately 140 to 160 characters.
- Include the main primary keyword or a natural close variant.
- Include the second primary keyword when it adds semantic value.
- Mention the location naturally.
- Mention the brand where appropriate.
- Clearly communicate what the page offers.
- Avoid keyword stuffing.
- Avoid repeating nearly identical keywords.
- Every Location + Service page should have a unique description.

==================================================
# 5. H1 AND HERO SECTION
==================================================

## H1

The H1 must include:

{{PRIMARY_KEYWORD_1}}

or a close natural variation.

Recommended structure:

{{PRIMARY_KEYWORD_1_NATURAL_VARIANT}}: {{VALUE_PROPOSITION}}

Example structure:

Anxiety Treatment in Anaheim Hills: Find Relief With Compassionate Care

## H1 Rules

- Include the main primary keyword naturally.
- A close keyword variant is acceptable.
- Do not force exact-match phrasing.
- Keep the heading readable and compelling.
- Do not stuff multiple similar primary keywords into the H1.
- Use only one H1 on the page.
- The H1 should accurately describe the page.
- The H1 does not need to exactly match the SEO title.

--------------------------------------------------

## Hero One-Liner

Write one concise sentence immediately below the H1.

The Hero One-Liner should naturally include:

{{PRIMARY_KEYWORD_1}}

or a close variant.

Recommended structure:

At {{BRAND_NAME}} in {{LOCATION_NAME}}, we provide {{PRIMARY_KEYWORD_1_NATURAL_VARIANT}} designed to help {{TARGET_AUDIENCE}} {{PRIMARY_BENEFIT}}.

## Hero One-Liner Rules

- Include the main primary keyword or a natural close variant.
- Do not force exact-match keyword usage.
- Keep the sentence concise.
- Mention the brand where appropriate.
- Mention the location naturally.
- Explain the service benefit.
- Do not repeat the H1 word-for-word.
- Do not keyword-stuff.

==================================================
# 6. LOCATION INFORMATION
==================================================

Display relevant location information near the top of the page.

Address:
{{LOCATION_ADDRESS}}

Phone:
{{PHONE_NUMBER}}

Directions / Map:
{{MAP_DATA}}

Serving Areas:
{{SERVING_AREAS}}

Ages Served:
{{AGES_SERVED}}

## Missing Data Rule

If any location-specific information is unavailable:

DO NOT invent it.

Return or flag:

DATA REQUIRED FROM CLIENT

Examples:

LOCATION ADDRESS REQUIRED FROM CLIENT

PHONE NUMBER REQUIRED FROM CLIENT

SERVING AREAS REQUIRED FROM CLIENT

AGES SERVED REQUIRED FROM CLIENT

==================================================
# 7. CORE INFORMATIONAL SECTIONS
==================================================

IMPORTANT:

The Core Informational Sections should NOT be generated from a fixed list by default.

The primary source for deciding these sections should be:

{{COMPETITOR_URLS}}

and/or:

{{COMPETITOR_PAGE_CONTENT}}

Claude should analyze relevant competitor Location + Service pages and identify the common and useful informational topics covered across those pages.

## Competitor Research Logic

For the target:

{{SERVICE_NAME}} in {{LOCATION_NAME}}

review relevant competitor pages targeting the same or closely related service.

Identify:

- Common H2 topics
- Recurring service information
- Symptoms discussed
- Causes or risk factors discussed
- Types of the condition/service
- Treatment approaches
- Benefits
- What to expect
- When to seek professional help
- Eligibility or candidates
- Treatment process
- Recovery
- Frequently discussed patient concerns
- Other service-specific topics

Do NOT copy competitor headings or content verbatim.

Use competitor pages only to understand:

1. Search intent
2. Expected page depth
3. Important subtopics
4. Content gaps
5. Common user questions

Then create original headings and writing instructions.

--------------------------------------------------

## Competitor Coverage Rule

Prioritize sections that:

- Appear across multiple relevant competitors.
- Directly answer user search intent.
- Are closely related to the service.
- Can naturally incorporate target keywords.
- Add useful information rather than filler.

Do not add sections simply because one competitor includes them.

--------------------------------------------------

## Keyword Usage in Core Sections

Use relevant keywords from:

{{PRIMARY_KEYWORDS}}

and:

{{SECONDARY_KEYWORDS}}

Map keywords to the most relevant sections.

Do not force every keyword onto the page.

Use keywords:
- Naturally
- Contextually
- Where they genuinely relate to the section

Avoid:
- Exact-match keyword repetition
- Keyword stuffing
- Unnatural keyword placement
- Adding irrelevant sections just to target a keyword

--------------------------------------------------

## Competitor Fallback Rule

If competitor pages provide insufficient detail or very limited section coverage, use the following section examples as fallback references.

These are fallback structures, NOT mandatory headings.

### Possible Section 1

What Is {{SERVICE_OR_CONDITION}}?

Purpose:

Explain the service, condition, treatment, or procedure clearly for someone unfamiliar with it.

Writing instructions:

- Use accessible language.
- Define the topic clearly.
- Explain what it involves.
- Explain its purpose where relevant.
- Avoid unnecessary jargon.
- Keep it informative and easy to understand.

Suggested content length:

500 to 700 characters.

--------------------------------------------------

### Possible Section 2

Symptoms of {{CONDITION}}

OR

Signs You May Need {{SERVICE_NAME}}

OR

Who May Benefit From {{SERVICE_NAME}}?

Writing instructions:

Explain common symptoms, signs, concerns, or reasons someone may need professional care.

Where relevant, discuss:

- Physical symptoms
- Emotional symptoms
- Behavioral symptoms
- Functional problems
- Common patient concerns

Suggested content length:

500 to 700 characters.

--------------------------------------------------

### Possible Section 3

What Causes {{CONDITION}}?

OR

Risk Factors for {{CONDITION}}

Use only when appropriate.

Writing instructions:

Explain relevant contributing factors.

Potential topics may include:

- Genetics
- Biological factors
- Lifestyle
- Environment
- Health conditions
- Trauma
- Stress
- Habits
- Age
- Other service-specific factors

Avoid presenting correlation as definite causation.

Suggested content length:

500 to 700 characters.

--------------------------------------------------

### Possible Section 4

Types of {{CONDITION}}

OR

Types of {{SERVICE_NAME}}

OR

{{SERVICE_NAME}} Options

OR

Treatment Options for {{CONDITION}}

Use when multiple types, approaches, or options exist.

For each option:

1. Name it.
2. Briefly explain it.
3. Explain how it differs where useful.

Suggested content length:

500 to 700 characters or appropriate to the number of options.

--------------------------------------------------

### Possible Section 5

How Can {{SERVICE_NAME}} Help?

OR

Benefits of {{SERVICE_NAME}} in {{LOCATION_NAME}}

OR

How Does {{SERVICE_NAME}} Support Daily Life?

Discuss practical benefits.

Potential topics:

- Symptom management
- Comfort
- Daily functioning
- Emotional well-being
- Quality of life
- Confidence
- Relationships
- Long-term management

Do not guarantee outcomes.

Suggested content length:

500 to 700 characters.

--------------------------------------------------

### Possible Section 6

When Should You Seek Professional Help for {{CONDITION}}?

OR

When Should You Consider {{SERVICE_NAME}} in {{LOCATION_NAME}}?

Explain when professional evaluation or care may be appropriate.

Potential indicators:

- Symptoms persist.
- Symptoms worsen.
- Symptoms interfere with daily activities.
- Symptoms cause significant distress.
- Self-management is not helping.
- Work, sleep, relationships, eating, school, or daily functioning are affected.

Keep the language supportive.

Avoid fear-based messaging.

Suggested content length:

500 to 700 characters.

==================================================
# 8. SERVICE-SPECIFIC SECTIONS
==================================================

Additional sections should be determined primarily from competitor research and search intent.

Potential sections include:

- Treatment Process
- How Treatment Works
- What to Expect
- Diagnosis
- Treatment Approaches
- Therapy Options
- Procedure Steps
- Benefits
- Recovery
- Aftercare
- Preparation
- Candidates
- Eligibility
- Prevention
- Technology Used
- Duration of Treatment
- Levels of Care
- Insurance and Payment
- Related Services
- Why Choose {{BRAND_NAME}}

Do NOT automatically add all of these.

Claude should determine which sections are relevant based on:

1. Competitor coverage
2. Search intent
3. Service type
4. Primary keywords
5. Secondary keywords
6. Available verified information
7. User usefulness

==================================================
# 9. FREQUENTLY ASKED QUESTIONS
==================================================

## H2: Frequently Asked Questions

Create:

5 to 7 FAQs with answers.

Both the QUESTIONS and ANSWERS should primarily be based on competitor research.

--------------------------------------------------

## FAQ Research Process

Analyze:

{{COMPETITOR_URLS}}

and/or:

{{COMPETITOR_PAGE_CONTENT}}

Identify common questions, topics, concerns, and informational gaps found across competitor pages.

Prioritize questions relating to:

- Service options
- Treatment process
- What to expect
- Duration
- Results or outcomes
- Eligibility
- Insurance
- Cost when reliable information exists
- Virtual or online availability
- Preparation
- Recovery
- Side effects or risks
- Common symptoms
- When to seek help
- Location-specific availability
- Other common service-specific concerns

Do not copy competitor FAQ wording verbatim.

Create original questions representing the same search intent.

--------------------------------------------------

## FAQ Selection Rules

Generate 5 to 7 questions.

Prioritize questions that:

1. Appear across multiple competitors.
2. Represent genuine user concerns.
3. Are directly relevant to {{SERVICE_NAME}}.
4. Support the search intent of the page.
5. Complement the page content rather than duplicate it.
6. Can be answered accurately using verified information.

--------------------------------------------------

## Location Usage in FAQs

Not every FAQ needs to include {{LOCATION_NAME}}.

Use location modifiers only where they add relevance.

Good examples:

What types of anxiety treatment are available in {{LOCATION_NAME}}?

How do I know if I need professional anxiety treatment?

How long does anxiety treatment usually take?

Does {{BRAND_NAME}} accept insurance for anxiety treatment?

What should I expect during my first anxiety treatment appointment?

Avoid making every FAQ:

"...in {{LOCATION_NAME}}?"

This creates repetitive and unnatural content.

--------------------------------------------------

## FAQ Answer Rules

Each FAQ must include an actual answer.

Answers should:

- Directly answer the question first.
- Be concise but useful.
- Use natural language.
- Be original.
- Use verified information.
- Avoid unsupported claims.
- Avoid guaranteed outcomes.
- Avoid repeating keywords unnecessarily.

Where appropriate, use related primary and secondary keywords naturally.

Do NOT invent:

- Insurance acceptance
- Pricing
- Treatment availability
- Treatment duration
- Clinical outcomes
- Telehealth availability
- Provider credentials
- Location-specific services

If information cannot be verified, either:

1. Select a different FAQ, or
2. Flag the information as requiring client confirmation.

--------------------------------------------------

## FAQ Intro

Before the questions, write a short FAQ introduction.

Requirements:

- Approximately 2 to 3 sentences.
- Maximum approximately 300 characters.
- Approximately 30 to 40 words.
- Explain what visitors can learn from the FAQs.
- Do not repeat the actual FAQ answers.

==================================================
# 10. COMPETITOR RESEARCH OUTPUT
==================================================

Before creating the final page brief, Claude should internally determine:

COMPETITOR_1:
{{COMPETITOR_1_URL}}

Relevant Sections Found:
{{COMPETITOR_1_SECTIONS}}

COMPETITOR_2:
{{COMPETITOR_2_URL}}

Relevant Sections Found:
{{COMPETITOR_2_SECTIONS}}

COMPETITOR_3:
{{COMPETITOR_3_URL}}

Relevant Sections Found:
{{COMPETITOR_3_SECTIONS}}

Additional Competitors:
{{ADDITIONAL_COMPETITORS}}

Then identify:

COMMON_COMPETITOR_TOPICS:
{{COMMON_COMPETITOR_TOPICS}}

UNIQUE_RELEVANT_TOPICS:
{{UNIQUE_RELEVANT_TOPICS}}

FAQ_TOPICS_FOUND:
{{FAQ_TOPICS_FOUND}}

CONTENT_GAPS:
{{CONTENT_GAPS}}

RECOMMENDED_PAGE_SECTIONS:
{{RECOMMENDED_PAGE_SECTIONS}}

This research can be used internally and does not necessarily need to appear on the final page.

==================================================
# 11. KEYWORD MAPPING
==================================================

Claude should map keywords to page sections before generating content.

Example internal structure:

Primary Keyword 1:
{{PRIMARY_KEYWORD_1}}

Primary Keyword 2:
{{PRIMARY_KEYWORD_2}}

SEO Title Keyword:
{{SEO_TITLE_KEYWORD}}

Meta Description Keywords:
{{META_DESCRIPTION_KEYWORDS}}

H1 Keyword:
{{H1_KEYWORD}}

Hero Keyword:
{{HERO_KEYWORD}}

Section 1 Keywords:
{{SECTION_1_KEYWORDS}}

Section 2 Keywords:
{{SECTION_2_KEYWORDS}}

Section 3 Keywords:
{{SECTION_3_KEYWORDS}}

FAQ Keywords:
{{FAQ_KEYWORDS}}

## Keyword Mapping Rules

- Do not assign every keyword everywhere.
- Match keywords to relevant search intent.
- Use close variants where appropriate.
- Avoid repeating very similar keywords.
- Prioritize natural readability.
- Do not create sections purely to insert keywords.

==================================================
# 12. INTERNAL PAGE DATA STRUCTURE
==================================================

Recommended implementation format:

{
  "brand_name": "{{BRAND_NAME}}",
  "domain": "{{DOMAIN}}",

  "service": {
    "name": "{{SERVICE_NAME}}",
    "slug": "{{SERVICE_SLUG}}"
  },

  "location": {
    "name": "{{LOCATION_NAME}}",
    "slug": "{{LOCATION_SLUG}}",
    "city": "{{CITY}}",
    "state": "{{STATE}}",
    "state_abbreviation": "{{STATE_ABBREVIATION}}",
    "address": "{{LOCATION_ADDRESS}}",
    "phone": "{{PHONE_NUMBER}}",
    "serving_areas": "{{SERVING_AREAS}}",
    "ages_served": "{{AGES_SERVED}}",
    "map_data": "{{MAP_DATA}}"
  },

  "keywords": {
    "primary_keyword_1": "{{PRIMARY_KEYWORD_1}}",
    "primary_keyword_2": "{{PRIMARY_KEYWORD_2}}",
    "primary_keywords": [],
    "secondary_keywords": []
  },

  "competitors": [
    {
      "url": "{{COMPETITOR_URL}}",
      "sections_found": [],
      "faq_topics": []
    }
  ],

  "seo": {
    "url": "",
    "title": "",
    "meta_description": "",
    "h1": "",
    "hero_one_liner": ""
  },

  "sections": [],

  "faqs": [
    {
      "question": "",
      "answer": ""
    }
  ]
}

==================================================
# 13. CONTENT GENERATION RULES
==================================================

When generating any Location + Service page:

1. Use competitor research to determine the core informational sections.

2. Use the fallback section examples only when competitor coverage is insufficient.

3. Include {{PRIMARY_KEYWORD_1}} or a close natural variant in:
   - SEO Title
   - Meta Description
   - H1
   - Hero One-Liner

4. Ideally incorporate {{PRIMARY_KEYWORD_2}} in the Meta Description when it is sufficiently different and can be included naturally.

5. Do not repeat primary keywords when they represent essentially the same phrase.

6. Close keyword variants are acceptable when they improve natural language.

7. Use relevant primary and secondary keywords naturally throughout informational sections.

8. Do not keyword-stuff.

9. Do not create content sections simply to use additional keywords.

10. Do not copy competitor content.

11. Competitor pages should influence:
    - Topic selection
    - Search intent
    - Content depth
    - FAQ selection
    - Section coverage

12. Every page must contain original content.

13. Do not simply duplicate one page and replace the location name.

14. Adapt the content to the specific service.

15. Use location terminology where it adds search or user relevance.

16. Do not overuse the location name throughout every paragraph.

17. Do not invent location information.

18. Do not invent service availability.

19. Do not invent insurance information.

20. Do not invent pricing.

21. Do not invent clinical claims.

22. Do not guarantee results.

23. Use verified client information for factual business claims.

24. Maintain proper H1 > H2 > H3 hierarchy.

25. Use only one H1.

26. Keep headings descriptive and useful.

27. Avoid unnecessarily repetitive headings.

28. Keep tone consistent with {{BRAND_NAME}}.

29. Generate 5 to 7 FAQ questions AND answers.

30. Base FAQ topics primarily on competitor research.

31. Flag missing required factual information instead of guessing.

==================================================
# 14. PAGE SECTION LOGIC
==================================================

Treat sections as:

## REQUIRED

- SEO URL
- SEO Title
- Meta Description
- Keyword Targets
- H1
- Hero One-Liner
- Location Information
- Core Service Information
- Frequently Asked Questions

## COMPETITOR-DEPENDENT

Examples:

- Symptoms
- Causes
- Types
- Treatment Options
- Benefits
- What to Expect
- Treatment Process
- When to Seek Help
- Preparation
- Recovery
- Eligibility
- Levels of Care
- Related Conditions

Include these based on competitor research and service relevance.

## DATA-DEPENDENT

- Address
- Phone
- Serving Areas
- Ages Served
- Map
- Insurance information
- Pricing
- Specific service availability
- Telehealth availability

Never fabricate DATA-DEPENDENT information.

==================================================
# 15. FINAL PAGE BRIEF STRUCTURE
==================================================

Default output:

## SEO DETAILS

Suggested URL:
{{GENERATED_URL}}

Suggested SEO Title:
{{GENERATED_TITLE}}

Character Count:
{{TITLE_CHARACTER_COUNT}}

Suggested Meta Description:
{{GENERATED_META_DESCRIPTION}}

Character Count:
{{META_DESCRIPTION_CHARACTER_COUNT}}

--------------------------------------------------

## KEYWORDS TO BE USED

Primary Keywords:

{{PRIMARY_KEYWORDS_TABLE}}

Secondary Keywords:

{{SECONDARY_KEYWORDS_TABLE}}

--------------------------------------------------

## H1

{{GENERATED_H1}}

--------------------------------------------------

## HERO ONE-LINER

{{GENERATED_HERO_ONE_LINER}}

--------------------------------------------------

## LOCATION DETAILS

Address:
{{LOCATION_ADDRESS}}

Phone:
{{PHONE_NUMBER}}

Directions:
{{MAP_DATA}}

Serving Areas:
{{SERVING_AREAS}}

Ages Served:
{{AGES_SERVED}}

--------------------------------------------------

## CORE CONTENT SECTIONS

Generate sections based primarily on competitor analysis.

For each section return:

H2:
{{H2_HEADING}}

Writing Instructions:
{{SECTION_WRITING_INSTRUCTIONS}}

Relevant Keywords:
{{SECTION_KEYWORDS}}

Suggested Character Limit:
{{SECTION_CHARACTER_LIMIT}}

Repeat for every recommended section.

--------------------------------------------------

## FREQUENTLY ASKED QUESTIONS

FAQ Introduction:
{{FAQ_INTRO}}

Q1:
{{FAQ_QUESTION_1}}

Answer:
{{FAQ_ANSWER_1}}

Q2:
{{FAQ_QUESTION_2}}

Answer:
{{FAQ_ANSWER_2}}

Q3:
{{FAQ_QUESTION_3}}

Answer:
{{FAQ_ANSWER_3}}

Q4:
{{FAQ_QUESTION_4}}

Answer:
{{FAQ_ANSWER_4}}

Q5:
{{FAQ_QUESTION_5}}

Answer:
{{FAQ_ANSWER_5}}

Q6:
{{FAQ_QUESTION_6}}

Answer:
{{FAQ_ANSWER_6}}

Q7:
{{FAQ_QUESTION_7}}

Answer:
{{FAQ_ANSWER_7}}

Generate between 5 and 7 FAQs depending on the strength and relevance of competitor research.

==================================================
# 16. CRITICAL DEVELOPMENT REQUIREMENT
==================================================

Build this as a reusable Location + Service page generation system.

DO NOT build individual hard-coded pages.

The system must dynamically support combinations such as:

{{SERVICE_A}} + {{LOCATION_A}}

{{SERVICE_B}} + {{LOCATION_A}}

{{SERVICE_A}} + {{LOCATION_B}}

{{SERVICE_C}} + {{LOCATION_C}}

The underlying page framework should remain reusable.

The following should change dynamically:

- URL
- SEO Title
- Meta Description
- Primary Keywords
- Secondary Keywords
- H1
- Hero One-Liner
- Location Details
- Core Sections
- Section Keywords
- Section Writing Instructions
- FAQs
- FAQ Answers

==================================================
# 17. IMPORTANT COMPETITOR RESEARCH PRINCIPLE
==================================================

Competitors determine the TOPICS, not the final COPY.

Use competitor research to understand:

"What information should this page cover?"

Do not use competitors to determine:

"What exact sentences should this page contain?"

The final output must be original, useful, keyword-aligned, and appropriate for {{BRAND_NAME}}.