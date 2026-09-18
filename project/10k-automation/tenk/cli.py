"""Command line entry points.

    python -m tenk.cli run --dry-run        the morning job, printing every write
    python -m tenk.cli run                  the morning job, for real
    python -m tenk.cli authorize            one-time Whoop OAuth, needs a browser
    python -m tenk.cli summary              build and deliver the Sunday summary
    python -m tenk.cli show --week 7        print a week as it stands
    python -m tenk.cli selftest             run against synthetic Whoop data
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import logging
import secrets
import sys
from pathlib import Path
from typing import List, Optional
from zoneinfo import ZoneInfo

from .config import Config, ConfigError
from .logging_setup import setup
from .plan import Plan, WEEKDAYS
from .state import RunState, TokenStore

log = logging.getLogger("tenk")


def _date(value: Optional[str]) -> Optional[dt.date]:
    return dt.date.fromisoformat(value) if value else None


def cmd_run(args) -> int:
    from .engine import DailyEngine

    config = Config.load(args.config)
    setup(logging.DEBUG if args.verbose else logging.INFO, config.state_dir / "engine.log")
    engine = DailyEngine(config, dry_run=args.dry_run, today=_date(args.date))
    report = engine.run()
    print(json.dumps(report.as_dict(), indent=2))
    if args.window:
        print("\nRolling window:")
        for line in report.window:
            print(f"  {line}")
    return 0


def cmd_summary(args) -> int:
    from .engine import DailyEngine
    from .summary import build_week_summary, deliver, render_slack

    config = Config.load(args.config)
    setup(logging.INFO, config.state_dir / "engine.log")
    engine = DailyEngine(config, dry_run=args.dry_run, today=_date(args.date))
    week = engine.plan.week_for(engine.today)
    if week is None:
        print("Today is outside the plan block; no summary.")
        return 0

    intervals = None
    try:
        intervals = engine._intervals_client()
    except ConfigError as exc:
        log.warning("intervals.icu not configured: %s", exc)
    completions = engine.read_completions(intervals, days_back=9)
    summary = build_week_summary(engine.plan, engine.state, week, completions)
    message = render_slack(engine.plan, summary, today=engine.today)
    print(message)
    result = deliver(config, message, title=f"Week {week.number} training summary", dry_run=args.dry_run)
    print(f"\n{result.detail}")
    if result.path:
        print(f"Copy on disk: {result.path}")
    return 0 if result.delivered or args.dry_run else 1


def cmd_authorize(args) -> int:
    """One-time Whoop OAuth. Opens a browser, catches the redirect locally."""
    import threading
    import webbrowser
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import parse_qs, urlparse

    from .whoop import WhoopClient

    config = Config.load(args.config)
    setup(logging.INFO)
    settings = config.whoop
    redirect = settings.get("redirect_uri", "http://localhost:8723/callback")
    parsed = urlparse(redirect)
    client = WhoopClient(
        client_id=Config.secret("WHOOP_CLIENT_ID"),
        client_secret=Config.secret("WHOOP_CLIENT_SECRET"),
        token_store=TokenStore(config.token_file),
        api_base=settings.get("api_base"),
        token_url=settings.get("token_url"),
        auth_url=settings.get("auth_url"),
        scopes=settings.get("scopes", []),
    )
    client.set_redirect_uri(redirect)
    state = secrets.token_urlsafe(16)
    holder: dict = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            query = parse_qs(urlparse(self.path).query)
            holder.update({k: v[0] for k, v in query.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write("Whoop is connected. You can close this tab.".encode("utf-8"))

        def log_message(self, *_args):  # silence the default stderr logging
            return

    server = HTTPServer((parsed.hostname or "localhost", parsed.port or 8723), Handler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    url = client.authorize_url(state)
    print("Open this if a browser does not:\n", url)
    webbrowser.open(url)
    server_thread_timeout = 300
    waited = 0.0
    import time

    while "code" not in holder and "error" not in holder and waited < server_thread_timeout:
        time.sleep(0.5)
        waited += 0.5
    server.server_close()

    if "error" in holder:
        print(f"Whoop returned an error: {holder['error']}", file=sys.stderr)
        return 1
    if "code" not in holder:
        print("No authorisation code came back within five minutes.", file=sys.stderr)
        return 1
    if holder.get("state") != state:
        print("State mismatch on the OAuth redirect; refusing to exchange the code.", file=sys.stderr)
        return 1

    client.exchange_code(holder["code"])
    print(f"Tokens stored at {config.token_file} (0600). The refresh token rotates on every use.")
    return 0


def cmd_check(args) -> int:
    """Verify the setup and name anything missing. Reads secrets, prints none."""
    from .doctor import Doctor, render

    config = Config.load(args.config)
    setup(logging.WARNING)

    def intervals_factory():
        from .engine import DailyEngine
        return DailyEngine(config, dry_run=True)._intervals_client()

    def whoop_factory():
        from .engine import DailyEngine
        return DailyEngine(config, dry_run=True)._whoop_client()

    doctor = Doctor(
        config,
        intervals_factory=None if args.offline else intervals_factory,
        whoop_factory=None if args.offline else whoop_factory,
        today=_date(args.date),
    )
    checks = doctor.run()
    print(render(checks))
    return 1 if any(c.blocking for c in checks) else 0


def cmd_show(args) -> int:
    from .adjust import summarise_day

    config_path = args.config
    try:
        config = Config.load(config_path)
        plan = Plan.load(config.plan_file)
    except ConfigError:
        plan = Plan.load(Path(__file__).resolve().parent.parent / "config" / "plan.yaml")

    weeks = [w for w in plan.weeks if args.week is None or w.number == args.week]
    for week in weeks:
        allocation = plan.allocate(week)
        print(f"\n=== Week {week.number}: {week.start} to {week.end} — "
              f"target {week.volume_km:g} km, planned {allocation.planned_total:g} km")
        if week.note:
            print(f"    {week.note}")
        for offset in range(7):
            day = week.start + dt.timedelta(days=offset)
            plan_day = plan.day_plan(day)
            print(f"  {day:%a %d %b}  {summarise_day(plan_day):<60} {plan_day.total_km or '':>6}")
        for note in allocation.notes:
            print(f"    ! {note}")
    return 0


def cmd_selftest(args) -> int:
    """Run the engine end to end against synthetic Whoop data. Writes nothing."""
    from .selftest import run_selftest

    setup(logging.INFO if not args.verbose else logging.DEBUG)
    return run_selftest(scenario=args.scenario, date=_date(args.date))


MIN_PYTHON = (3, 9)


def main(argv: Optional[List[str]] = None) -> int:
    if sys.version_info < MIN_PYTHON:
        print(
            f"This needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]} or newer; this is "
            f"{sys.version.split()[0]}. Make the virtualenv with a newer python3 and "
            f"run it through .venv/bin/python.",
            file=sys.stderr,
        )
        return 2
    parser = argparse.ArgumentParser(prog="tenk", description="10k PB daily automation")
    parser.add_argument("--config", default=None, help="path to config.yaml")
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="the morning job")
    run.add_argument("--dry-run", action="store_true", help="print every write, execute none")
    run.add_argument("--date", help="pretend today is this date (YYYY-MM-DD)")
    run.add_argument("--window", action="store_true", help="also print the rolling window")
    run.add_argument("--verbose", action="store_true")
    run.set_defaults(func=cmd_run)

    summary = sub.add_parser("summary", help="build and deliver the Sunday summary")
    summary.add_argument("--dry-run", action="store_true")
    summary.add_argument("--date")
    summary.set_defaults(func=cmd_summary)

    authorize = sub.add_parser("authorize", help="one-time Whoop OAuth")
    authorize.set_defaults(func=cmd_authorize)

    check = sub.add_parser("check", help="verify the setup and say what is missing")
    check.add_argument("--offline", action="store_true",
                       help="skip the network checks, only look at files and secrets")
    check.add_argument("--date", help="pretend today is this date (YYYY-MM-DD)")
    check.set_defaults(func=cmd_check)

    show = sub.add_parser("show", help="print the plan as it stands")
    show.add_argument("--week", type=int)
    show.set_defaults(func=cmd_show)

    selftest = sub.add_parser("selftest", help="end-to-end run against synthetic Whoop data")
    selftest.add_argument("--scenario", default="all")
    selftest.add_argument("--date")
    selftest.add_argument("--verbose", action="store_true")
    selftest.set_defaults(func=cmd_selftest)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"Configuration problem: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
