"""CLI entrypoint for gallery-dl-manager."""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request

import uvicorn

from app.api import create_app
from app.auth import AuthManager
from app.db import Database


def cmd_healthcheck(port: int) -> int:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5) as resp:
            return 0 if resp.status == 200 else 1
    except Exception:
        return 1


def cmd_reset_web_auth() -> int:
    db = Database()
    db.init_schema()
    auth = AuthManager(db)
    token = auth.reset_web_auth()
    auth.print_setup_banner(token)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="gallery-dl-manager")
    parser.add_argument("--serve", action="store_true", help="Run web console and scheduler")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("INTERNAL_PORT", "8766")))
    parser.add_argument("--healthcheck", action="store_true")
    parser.add_argument("--reset-web-auth", action="store_true")
    args = parser.parse_args(argv)

    if args.healthcheck:
        return cmd_healthcheck(args.port)
    if args.reset_web_auth:
        return cmd_reset_web_auth()

    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level="info", access_log=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
