import os
from rich.console import Console
from rich.panel import Panel
from rich.rule import Rule

if os.name == "nt":
    os.system("chcp 65001 > nul 2>&1")

console = Console(legacy_windows=False)

STATUS_COLORS = {
    "Pass": "green",
    "Needs Minor Edits": "yellow",
    "Needs Major Edits": "red",
    "Error": "red",
}

SEVERITY_COLORS = {
    "major": "red",
    "minor": "yellow",
}

SEVERITY_ICONS = {
    "major": "!!",
    "minor": "!",
}


def _score_bar(score: int, color: str) -> str:
    filled = round(score / 10)
    empty = 10 - filled
    bar = f"[{color}]{'#' * filled}[/{color}][dim]{'-' * empty}[/dim]"
    return f"{bar}  [bold]{score}/100[/bold]"


def display(result: dict, stage_name: str) -> None:
    status = result.get("overall_status", "Unknown")
    score = result.get("qc_score", 0)
    color = STATUS_COLORS.get(status, "white")

    console.print()
    console.print(Panel(
        f"[bold {color}]{status}[/bold {color}]\n{_score_bar(score, color)}",
        title=f"[bold]QC Result: {stage_name}[/bold]",
        border_style=color,
        padding=(1, 3),
    ))

    # ── Passed Checks ────────────────────────────────────────────────────────
    passed = result.get("passed_checks", [])
    if passed:
        console.print()
        console.rule("[bold green]  Passed Checks  [/bold green]", style="green dim")
        for check in passed:
            console.print(f"  [bold green]OK[/bold green]  {check}")

    # ── Issues Found ──────────────────────────────────────────────────────────
    issues = result.get("issues_found", [])
    if issues:
        console.print()
        console.rule("[bold red]  Issues Found  [/bold red]", style="red dim")
        for issue in issues:
            sev = issue.get("severity", "minor")
            sev_color = SEVERITY_COLORS.get(sev, "yellow")
            icon = SEVERITY_ICONS.get(sev, "!")
            console.print(
                f"\n  [{sev_color}][{icon} {sev.upper()}][/{sev_color}]  "
                f"[bold]{issue.get('check', '')}[/bold]"
            )
            console.print(f"        {issue.get('issue', '')}")
            reason = issue.get("reason", "")
            if reason:
                console.print(f"        [dim italic]Guideline: {reason}[/dim italic]")
    elif status != "Pass":
        console.print("\n[dim]No specific issues flagged.[/dim]")

    # ── Recommended Fixes ─────────────────────────────────────────────────────
    fixes = result.get("recommended_fixes", [])
    if fixes:
        console.print()
        console.rule("[bold cyan]  Recommended Fixes  [/bold cyan]", style="cyan dim")
        for i, fix in enumerate(fixes, 1):
            console.print(f"  [cyan]{i}.[/cyan] {fix}")

    # ── Suggested Edited Version ──────────────────────────────────────────────
    edited = result.get("suggested_edited_version", "")
    if edited and edited.strip():
        char_count = len(edited.strip())
        console.print()
        console.print(Panel(
            edited.strip() + f"\n\n[dim]({char_count} characters)[/dim]",
            title="[bold cyan]Suggested Edited Version[/bold cyan]",
            border_style="cyan",
            padding=(1, 2),
        ))

    # ── Final Recommendation ──────────────────────────────────────────────────
    recommendation = result.get("final_approval_recommendation", "")
    if recommendation:
        console.print()
        console.print(Panel(
            recommendation,
            title=f"[bold {color}]Final Recommendation[/bold {color}]",
            border_style=color,
            padding=(1, 2),
        ))

    console.print()


def display_generated(result: dict, location: str) -> None:
    char_count = result.get("character_count", 0)
    within_limit = result.get("within_limit", char_count <= 1500)
    count_color = "green" if within_limit else "red"
    count_label = "Within limit" if within_limit else "OVER LIMIT"

    console.print()
    console.print(Panel(
        f"[bold cyan]Location:[/bold cyan] [bold]{location}[/bold]\n"
        f"[{count_color}]{count_label}[/{count_color}]  "
        f"[bold]{char_count}[/bold] / 1500 characters",
        title="[bold]Location Content Generator[/bold]",
        border_style="cyan",
        padding=(1, 3),
    ))

    sections = result.get("sections_included", [])
    if sections:
        console.print()
        console.rule("[bold green]  Sections Included  [/bold green]", style="green dim")
        console.print("  " + "  |  ".join(f"[green]{s}[/green]" for s in sections))

    full_post = result.get("full_post", "").strip()
    if full_post:
        console.print()
        console.print(Panel(
            full_post + f"\n\n[dim]({char_count} characters)[/dim]",
            title="[bold cyan]Generated Post — Ready to Use[/bold cyan]",
            border_style="cyan",
            padding=(1, 2),
        ))

    notes = result.get("customization_notes", [])
    if notes:
        console.print()
        console.rule("[bold dim]  Customization Notes  [/bold dim]", style="dim")
        for note in notes:
            console.print(f"  [dim]-[/dim] {note}")

    console.print()
