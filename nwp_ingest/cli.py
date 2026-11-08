import argparse
from datetime import datetime, timezone
import json
import logging
import signal
import sys
import threading
from .models import load_config, parse_cycle
from .pipeline import Pipeline, writer_lock


def main():
    parser = argparse.ArgumentParser(description="Model Viewer ingestion and compilation")
    parser.add_argument("--config", default="config/starter.json")
    parser.add_argument("--data-root", default="data")
    parser.add_argument("--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("discover", help="Probe the latest usable cycle without downloading GRIB")
    for cmd in ("sync", "watch"):
        p = sub.add_parser(cmd, help="Ingest once" if cmd == "sync" else "Poll providers continuously")
        p.add_argument("--raw-only", action="store_true")
        if cmd == "sync":
            p.add_argument("--cycle", help="Explicit UTC cycle, e.g. 20261029T00Z")
    sub.add_parser("compile", help="Normalize and summarize downloaded forecasts")
    sub.add_parser("status", help="Print dataset catalog as JSON")
    p = sub.add_parser("serve", help="Serve local catalog dashboard and data API")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = load_config(args.config)
        pipeline = Pipeline(config, args.data_root)
        if args.command == "serve":
            from .server import serve
            serve(pipeline, args.host, args.port)
        elif args.command == "discover":
            from concurrent.futures import ThreadPoolExecutor
            from .models import cycle_id
            def discover(name):
                try:
                    return name, {"cycle": cycle_id(pipeline.discover(name))}
                except Exception as exc:
                    return name, {"error": str(exc)}
            with ThreadPoolExecutor(max_workers=config["workers"]) as pool:
                result = dict(pool.map(discover, config["models"]))
            print(json.dumps(result, indent=2))
            return 1 if any("error" in v for v in result.values()) else 0
        elif args.command == "status":
            path = pipeline.root / "catalog.json"
            print(path.read_text() if path.exists() else json.dumps({"status": "waiting", "models": []}))
        elif args.command == "compile":
            from .processing import compile_available
            with writer_lock(pipeline.root):
                compile_available(pipeline.catalog, config)
                pipeline.catalog.export(config)
        else:
            if not args.raw_only:
                from .processing import require_processing
                require_processing()
            if args.command == "sync":
                _, counts, errors = pipeline.sync(parse_cycle(args.cycle) if args.cycle else None, not args.raw_only)
                return 1 if errors or counts["failed"] else 2 if counts["pending"] else 0
            stopped = threading.Event()
            for signum in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signum, lambda *_: stopped.set())
            logging.info("Worker started; dataset=%s; interval=%ss", pipeline.root, config["poll_seconds"])
            while not stopped.is_set():
                try:
                    pipeline.sync(process=not args.raw_only)
                except Exception:
                    logging.exception("Poll failed; retrying next interval")
                stopped.wait(config["poll_seconds"])
    except Exception as exc:
        logging.error("%s", exc, exc_info=args.verbose)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
