#!/usr/bin/env python3
"""GBP Quality Check Agent — CLI Entry Point"""

import sys
import os
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv()

import questionary
from rich.console import Console
from rich.panel import Panel

from core.client_registry import ClientRegistry
from core.qc_engine import QCEngine
from core import output_formatter
from utils.exporter import Exporter

console = Console(legacy_windows=False)

BASE_STAGES = [
    ("Base Content Check", "base"),
    ("Expanded Content QC", "expanded"),
]

GENERATOR_STAGE = ("Location Content Generator", "generate")

_LABEL_OVERRIDES = {
    "awareness_holiday": "Awareness / Holiday",
    "family_lifestyle": "Family / Lifestyle",
}


def get_stages(guidelines: dict) -> list:
    stages = list(BASE_STAGES)
    if guidelines.get("content_generation_supported"):
        stages.append(GENERATOR_STAGE)
    return stages


def get_post_types(guidelines: dict) -> list:
    types_field = guidelines.get("post_types") or guidelines.get("post_themes") or {}
    if not types_field:
        return ["General"]
    return [
        _LABEL_OVERRIDES.get(key, key.replace("_", " ").title())
        for key in types_field.keys()
    ]


def collect_multiline(label: str) -> str:
    console.print(f"\n[bold]{label}[/bold]")
    console.print("[dim]Paste your text. When finished, type END on its own line and press Enter.[/dim]")
    lines = []
    while True:
        try:
            line = input()
            if line.strip().upper() == "END":
                break
            lines.append(line)
        except EOFError:
            break
    return "\n".join(lines).strip()


def check_api_key() -> bool:
    key = os.environ.get("OPENAI_API_KEY", "")
    if not key or key.startswith("your_api_key"):
        console.print(
            "[bold red]Error:[/bold red] OPENAI_API_KEY is not set.\n"
            "Open [dim].env[/dim] and replace [dim]your_api_key_here[/dim] with your OpenAI key."
        )
        return False
    return True


def run() -> None:
    console.print()
    console.print(Panel.fit(
        "[bold cyan]GBP Quality Check Agent[/bold cyan]\n"
        "[dim]Powered by GPT-4o mini[/dim]",
        border_style="cyan",
    ))

    if not check_api_key():
        sys.exit(1)

    registry = ClientRegistry()
    clients = registry.list_clients()

    if not clients:
        console.print("[red]No client guidelines found in clients/ directory.[/red]")
        sys.exit(1)

    # ── Client selector ──────────────────────────────────────────────────────
    client_choices = [c["name"] for c in clients]
    if len(client_choices) == 1:
        selected_name = client_choices[0]
        console.print(f"\n[dim]Client:[/dim] [bold]{selected_name}[/bold]")
    else:
        selected_name = questionary.select("Select a client:", choices=client_choices).ask()
        if not selected_name:
            sys.exit(0)

    client_id = next(c["id"] for c in clients if c["name"] == selected_name)
    guidelines = registry.load_client(client_id)
    console.print(f"[green]OK[/green] Loaded guidelines for [bold]{guidelines['client_name']}[/bold]")

    # ── Stage selector (dynamic per client) ──────────────────────────────────
    stages = get_stages(guidelines)
    stage_name = questionary.select(
        "Select stage:",
        choices=[s[0] for s in stages],
    ).ask()
    if not stage_name:
        sys.exit(0)

    stage_key = next(s[1] for s in stages if s[0] == stage_name)

    # ── Post type (dynamic per client) ───────────────────────────────────────
    post_types = get_post_types(guidelines)
    if len(post_types) == 1:
        post_type = post_types[0]
        console.print(f"[dim]Post Type:[/dim] [bold]{post_type}[/bold]")
    else:
        post_type = questionary.select("Select post type:", choices=post_types).ask()
        if not post_type:
            sys.exit(0)

    engine = QCEngine(guidelines)

    # ── Stage: Base Content Check ─────────────────────────────────────────────
    if stage_key == "base":
        topic = questionary.text("Approved topic / title:").ask()
        if not topic:
            sys.exit(0)

        content = collect_multiline("Base GBP Post Content")
        if not content:
            console.print("[red]No content provided. Exiting.[/red]")
            sys.exit(1)

        console.print("\n[dim]Running QC check...[/dim]\n")
        result = engine.check_base_content(topic, content, post_type)
        output_formatter.display(result, stage_name)

    # ── Stage: Expanded Content QC ────────────────────────────────────────────
    elif stage_key == "expanded":
        location = questionary.text("Location name:").ask() or ""

        base_content = collect_multiline("Approved Base Content")
        expanded_content = collect_multiline("Expanded / Location-Specific Content")

        if not base_content or not expanded_content:
            console.print("[red]Both base and expanded content are required. Exiting.[/red]")
            sys.exit(1)

        console.print("\n[dim]Running QC check...[/dim]\n")
        result = engine.check_expanded_content(base_content, expanded_content, post_type, location)
        output_formatter.display(result, stage_name)

    # ── Stage: Location Content Generator ────────────────────────────────────
    elif stage_key == "generate":
        console.print()
        console.print(Panel(
            "Select a location (or All Locations), paste your approved base content,\n"
            "and the generator will produce a fully customized, ready-to-post version.",
            border_style="cyan",
            padding=(0, 2),
        ))

        # Build location choices from guidelines
        raw_locations  = guidelines.get("locations", [])
        fmt            = guidelines.get("brand_name_with_location_format", "[Location]")
        exceptions     = guidelines.get("location_format_exceptions", [])

        def _display_loc(loc: str) -> str:
            if loc in exceptions:
                return loc
            return fmt.replace("[Location]", loc)

        if raw_locations:
            display_locations = [_display_loc(l) for l in raw_locations]
            choices = ["-- All Locations --"] + display_locations
            location_choice = questionary.select("Select location:", choices=choices).ask()
            if not location_choice:
                sys.exit(0)
            generate_all = location_choice == "-- All Locations --"
            selected_locations = display_locations if generate_all else [location_choice]
        else:
            loc_input = questionary.text("Location name:").ask()
            if not loc_input:
                sys.exit(0)
            generate_all = False
            selected_locations = [loc_input]

        base_content = collect_multiline("Approved Base Content")
        if not base_content:
            console.print("[red]No base content provided. Exiting.[/red]")
            sys.exit(1)

        if generate_all:
            total = len(selected_locations)
            console.print(
                f"\n[cyan]Generating posts for all {total} locations.[/cyan] "
                f"[dim]This may take a few minutes...[/dim]\n"
            )
            all_results = {}
            for i, loc in enumerate(selected_locations, 1):
                console.print(f"  [dim][{i}/{total}][/dim] Generating for [bold]{loc}[/bold]...")
                try:
                    all_results[loc] = engine.generate_location_content(
                        base_content, loc, post_type
                    )
                except Exception as e:
                    console.print(f"  [red]Failed for {loc}: {e}[/red]")
                    all_results[loc] = {
                        "full_post": "",
                        "character_count": 0,
                        "within_limit": False,
                        "sections_included": [],
                        "customization_notes": [f"Generation failed: {e}"],
                    }

            console.print(f"\n[green]OK[/green] All {total} locations generated. Exporting to Excel...\n")
            filepath = Exporter().to_all_locations_excel(
                all_results, client_id, post_type,
                client_name=guidelines.get("client_name"),
            )
            console.print(f"[green]OK[/green] Saved to [bold]{filepath}[/bold]")
            console.print("\n[dim]Done.[/dim]\n")
            return  # skip the normal export prompt below

        else:
            location = selected_locations[0]
            console.print(f"\n[dim]Generating for {location}...[/dim]\n")
            result = engine.generate_location_content(base_content, location, post_type)
            output_formatter.display_generated(result, location)

    else:
        console.print("[red]Unknown stage. Exiting.[/red]")
        sys.exit(1)

    # ── Export ────────────────────────────────────────────────────────────────
    export = questionary.confirm("Export results to Excel?", default=False).ask()
    if export:
        exporter = Exporter()
        if stage_key == "generate":
            # single-location generate — `location` is set in the generate block
            filepath = exporter.to_generated_excel(
                result, client_id, location,
                client_name=guidelines.get("client_name"),
            )
        else:
            filepath = exporter.to_csv(
                result, client_id, stage_key,
                client_name=guidelines.get("client_name"),
            )
        console.print(f"\n[green]OK[/green] Saved to [bold]{filepath}[/bold]")

    console.print("\n[dim]Done.[/dim]\n")


if __name__ == "__main__":
    run()
