---
description: Phase C — cross-domain coverage rollup after all domains are done
argument-hint: [optional run folder]
allowed-tools: Bash, Read, Write, Glob, Grep, TodoWrite
---

Run the cross-domain rollup.

## Setup

1. Read `audit-loop/config.json` for `runs_root` and the domains list.
2. Run folder: `$1` if given, otherwise the most recent folder under `runs_root`.
3. Check `audit-loop/PROGRESS.md` — if any domain has not completed phase B, list which ones
   and ask whether to roll up anyway. A partial rollup is fine, but the never-fired analysis
   in Step 2 gets weaker with each missing domain, so say so in the output.
4. Read `audit-loop/prompts/03-rollup.md`. **That file is your instructions.** Substitute
   `{{RUNS_ROOT}}` with the run folder.

## On finishing

Print the three things to fix before this tool is shown to a client, and the count of rules
that fired zero times across every domain — that number is the honest measure of how much of
the 96 you have actually tested.
