"""Entrypoint: python -m haro_agent.cli run [options]"""
from __future__ import annotations

import argparse
import os
import sys

from .pipeline import PipelineConfig, load_dotenv, parse_as_of, run_pipeline


def run(args) -> int:
    load_dotenv()
    config = PipelineConfig(
        source=args.source,
        samples_dir=args.samples_dir,
        profiles_path=args.profiles,
        settings_path=args.settings,
        state_dir=args.state_dir,
        reports_dir=args.reports_dir,
        lookback_hours=args.lookback_hours,
        llm_mode=args.llm,
        model=args.model,
        as_of=parse_as_of(args.as_of),
        notify_mode=args.notify,
        slack_webhook_url=args.slack_webhook_url or os.environ.get("SLACK_WEBHOOK_URL"),
    )
    result = run_pipeline(config)

    print(result.report_text)
    for line in result.log_lines:
        print(line, file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="haro_agent", description="HARO monitoring agent")
    sub = parser.add_subparsers(dest="command", required=True)

    run_parser = sub.add_parser("run", help="Run one HARO check")
    run_parser.add_argument("--source", choices=["local", "gmail"], default="local")
    run_parser.add_argument("--samples-dir", default="samples", help="Used when --source local")
    run_parser.add_argument("--profiles", default="config/profiles.example.yaml")
    run_parser.add_argument("--settings", default="config/settings.example.yaml")
    run_parser.add_argument("--state-dir", default="state")
    run_parser.add_argument("--reports-dir", default="reports")
    run_parser.add_argument("--lookback-hours", type=int, default=24)
    run_parser.add_argument(
        "--llm", choices=["claude", "mock"], default="claude",
        help="'mock' runs the full pipeline offline with heuristic scoring, no API key needed",
    )
    run_parser.add_argument("--model", default="claude-sonnet-5")
    run_parser.add_argument(
        "--as-of", default=None,
        help="ISO datetime to compute hours_remaining against, for reproducible local tests",
    )
    run_parser.add_argument(
        "--notify", choices=["none", "console", "slack"], default="none",
        help="'console' prints notifications locally, 'slack' posts to SLACK_WEBHOOK_URL "
        "for every Priority/Qualified match",
    )
    run_parser.add_argument(
        "--slack-webhook-url", default=None,
        help="Overrides SLACK_WEBHOOK_URL from the environment/.env",
    )
    run_parser.set_defaults(func=run)

    serve_parser = sub.add_parser("serve", help="Run the local web dashboard")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=5000)
    serve_parser.add_argument("--debug", action="store_true")

    def _serve(args) -> int:
        from .webapp import run_server

        run_server(host=args.host, port=args.port, debug=args.debug)
        return 0

    serve_parser.set_defaults(func=_serve)

    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
