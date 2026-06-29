# GBP Quality Check Agent

An AI-powered Google Business Profile (GBP) post quality check agent for reviewing content against client-specific brand guidelines.

Built with Claude AI (Anthropic) and a clean CLI interface using Rich and Questionary.

---

## Features

- Client-specific brand guideline storage (one JSON file per client)
- 3-stage QC workflow matching your production process
- Strict but practical reviews — only flags real violations
- Rich terminal output with color-coded status, scores, and issue severity
- CSV export for tracking and reporting
- Prompt caching to reduce API costs on repeated checks
- Extensible architecture for new clients and stages

---

## Setup

### 1. Install Python dependencies

```bash
cd gbp-qc-agent
pip install -r requirements.txt
```

### 2. Set your Anthropic API key

```bash
copy .env.example .env
```

Open `.env` and replace `your_api_key_here` with your actual key:

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run the agent

```bash
python main.py
```

---

## Project Structure

```
gbp-qc-agent/
├── main.py                      # CLI entry point — run this
├── requirements.txt
├── .env.example                 # Copy to .env and add your API key
│
├── clients/                     # One JSON file per client
│   └── ybh.json                 # YBH / Clear Behavioral Health guidelines
│
├── core/
│   ├── client_registry.py       # Discovers and loads client guideline files
│   ├── qc_engine.py             # Calls Claude API to perform the QC check
│   └── output_formatter.py      # Renders results in the terminal with Rich
│
├── stages/
│   ├── base_check.py            # Prompt builder for Base Content Check
│   ├── expanded_check.py        # Prompt builder for Expanded Content QC
│   └── published_check.py       # Prompt builder for Published Post Review
│
├── utils/
│   ├── url_fetcher.py           # Attempts to fetch content from a URL
│   └── exporter.py              # Exports QC results to CSV
│
├── examples/
│   ├── sample_base_input.json   # Sample input for a base content check
│   └── sample_output.json       # Sample QC result JSON
│
└── exports/                     # CSV exports are saved here
```

---

## Usage

Run `python main.py` and follow the interactive prompts:

**Step 1 — Select a client**
Choose from the available clients. Each client has its own saved guidelines.

**Step 2 — Select a QC stage**

| Stage | When to use |
|---|---|
| Base Content Check | Reviewing the first draft of a GBP post before sending to client |
| Expanded Content QC | Reviewing location-specific versions against the approved base |
| Published Post Review | Verifying a live published GBP post against approved content |

**Step 3 — Select post type**
Mental Health / Addiction / Teen / Awareness-Holiday / General

**Step 4 — Provide content**
Paste your text when prompted. Type `END` on a new line when done.

---

## QC Output

Every check returns:

| Field | Description |
|---|---|
| Overall Status | Pass / Needs Minor Edits / Needs Major Edits |
| QC Score | 0–100 (90+ = Pass, 70–89 = Minor, 0–69 = Major) |
| Passed Checks | List of all checks that passed |
| Issues Found | Each issue with severity (major/minor) and description |
| Recommended Fixes | Specific, actionable suggestions |
| Suggested Edited Version | Corrected post text (only if violations found) |
| Final Approval Recommendation | Clear go/no-go paragraph |

---

## Adding a New Client

1. Create a new file in `clients/`: `clients/yourclient.json`
2. Use `clients/ybh.json` as the template
3. Fill in the client's: name, website, character limit, post types, locations, notes, tone, CTA rules, and special rules
4. The new client will automatically appear in the client selector next time you run the agent

No code changes needed.

---

## YBH / Clear Behavioral Health — Key Rules Reference

| Rule | Detail |
|---|---|
| Character limit | Under 1500 characters per post |
| Link | Required — program/treatment page or location page URL |
| CTA | Required — any CTA wording is acceptable |
| DBT spelling | "Dialectical **Behavior** Therapy" (not Behavioral) |
| Teen topics | Restricted to: Depression, Anxiety, Bipolar Disorder, PTSD, School Issues, Failure to Launch |
| Online location | Never mention location name — write a general post |
| Torrance 18123 | Offers both day and evening virtual tracks |
| Bakersfield | Offers both day and evening virtual tracks |

**Mental Health locations** (include name): Los Angeles, Manhattan Beach, Torrance Residential 18616, Pasadena, Redondo Beach Outpatient, Redondo 201, El Segundo, Van Nuys, El Monte, Santa Clarita, Los Angeles Residential, Southbay

**Addiction locations** (include name): Redondo Beach Rehab 326/328, Redondo 201, Gardena

**Teen locations** (include name): Los Angeles, Redondo Beach, Pasadena, Van Nuys, El Monte, El Segundo, Santa Clarita

---

## Roadmap

- [ ] Web UI (Flask/FastAPI) for browser-based access
- [ ] Google Sheets export
- [ ] Batch review of multiple posts at once
- [ ] Additional QC stages (e.g., Topic Approval Check)
- [ ] Scheduling / automated review integration
