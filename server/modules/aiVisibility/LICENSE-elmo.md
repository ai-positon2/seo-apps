# Third-party notice — Elmo

The DataForSEO surface adapters in `surfaces/` are derived from Elmo, an
open-source AI visibility platform, and specifically from
`packages/lib/src/providers/registry/dataforseo.ts` and
`packages/lib/src/text-extraction.ts`.

Source: https://github.com/elmohq/elmo

What was taken is the operational knowledge rather than the literal code — the
code here is CommonJS JavaScript calling DataForSEO's REST API directly, where
Elmo is TypeScript over the `dataforseo-client` SDK. What carried across is the
part that took someone real time to learn:

* which of DataForSEO's three products serves which surface (SERP endpoints,
  AI Optimization "LLM Scraper", AI Optimization "LLM Responses"), and that the
  LLM Scraper is the one that drives the real chatgpt.com interface;
* `force_web_search` on ChatGPT, because ChatGPT otherwise decides per prompt
  whether to search and a tracked run must consistently reflect the browsing
  experience;
* `load_async_ai_overview` on the organic SERP endpoint, without which
  DataForSEO returns only what it had cached and most runs come back empty;
* that the AI Overview call intermittently fails with a task-level
  "Internal SE Server Error" and needs a short retry;
* that `task.status_code === 20000` is the real success check, separate from the
  HTTP status;
* that citations live in `result.sources` and `items[].sources`, and that
  ChatGPT's `search_results` must be ignored — those are results the model was
  shown, not sources it cited.

That last point is a correctness distinction, not a detail: counting
`search_results` as citations would materially overstate a brand's presence.

The MIT licence below is reproduced as required.

---

MIT License

Copyright (c) 2026 Blue Whale Software, LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
