"""Local status UI and bounded JSON API for the future map viewer."""
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from .models import MODELS, FIELDS, parse_cycle


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, pipeline, **kwargs):
        self.pipeline = pipeline
        super().__init__(*args, **kwargs)

    def send(self, body, code=200, mime="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def json(self, value, code=200):
        self.send(json.dumps(value, allow_nan=False).encode(), code)

    def do_GET(self):
        url = urlsplit(self.path)
        try:
            if url.path == "/":
                self.send(Path(__file__).with_name("dashboard.html").read_bytes(), mime="text/html")
            elif url.path in ("/api/catalog", "/health"):
                path = self.pipeline.root / "catalog.json"
                if not path.exists():
                    self.json({"status": "waiting", "message": "Run sync or watch to populate this dataset", "models": []})
                    return
                data = json.loads(path.read_text())
                if url.path == "/health":
                    from datetime import datetime, timezone
                    age = (datetime.now(timezone.utc) - datetime.fromisoformat(data["generated_at"])).total_seconds()
                    self.json({"status": "ok" if age <= 2 * self.pipeline.config["poll_seconds"] else "stale", "catalog_age_seconds": age})
                else:
                    last = self.pipeline.root / "last_sync.json"
                    data["last_sync"] = json.loads(last.read_text()) if last.exists() else None
                    self.json(data)
            elif url.path in ("/api/field", "/api/point"):
                self.field(url.path, parse_qs(url.query))
            else:
                self.json({"error": "Not found"}, 404)
        except FileNotFoundError:
            self.json({"error": "Requested compiled forecast is not available"}, 404)
        except (ValueError, KeyError, IndexError) as exc:
            self.json({"error": str(exc)}, 400)
        except Exception:
            self.json({"error": "Data processing failed; check server logs"}, 500)
            import logging
            logging.exception("API request failed")

    def field(self, endpoint, query):
        import numpy as np
        def arg(key, default=None):
            value = query.get(key, [default])[0]
            if value is None:
                raise ValueError(f"Missing query parameter: {key}")
            return value
        name, cycle = arg("model"), arg("cycle")
        if name not in MODELS:
            raise ValueError("Unknown model")
        parse_cycle(cycle)
        lead = int(arg("lead"))
        if not 0 <= lead <= 384:
            raise ValueError("lead must be in 0..384")
        field, stat = arg("field", "t2m"), arg("stat", "mean")
        if field not in FIELDS and field != "ws10":
            raise ValueError("Unknown field")
        if stat not in ("mean", "spread", "p10", "p50", "p90", "member_count"):
            raise ValueError("Unknown statistic")
        path = self.pipeline.root / "compiled" / name / cycle / f"f{lead:03d}.npz"
        metadata = json.loads(path.with_suffix(".json").read_text())
        key = f"{field}__{stat}" if MODELS[name].ensemble else field
        with np.load(path) as data:
            lat, lon, values = data["latitude"], data["longitude"], data[key]
            if endpoint == "/api/point":
                latitude, longitude = float(arg("lat")), float(arg("lon"))
                if not np.isfinite(latitude) or not np.isfinite(longitude) or not -90 <= latitude <= 90:
                    raise ValueError("Invalid latitude/longitude")
                longitude = (longitude + 180) % 360 - 180
                i = int(np.abs(lat - latitude).argmin())
                j = int(np.abs((lon - longitude + 180) % 360 - 180).argmin())
                number = float(values[i, j])
                self.json({"metadata": metadata, "field": field, "statistic": stat if MODELS[name].ensemble else "deterministic",
                           "latitude": float(lat[i]), "longitude": float(lon[j]), "value": number if np.isfinite(number) else None})
            else:
                width = min(720, max(36, int(arg("width", "360"))))
                stride = max(1, int(np.ceil(len(lon) / width)))
                arr = values[::stride, ::stride]
                safe = np.where(np.isfinite(arr), arr, None).tolist()
                self.json({"metadata": metadata, "field": field, "statistic": stat if MODELS[name].ensemble else "deterministic",
                           "latitude": lat[::stride].tolist(), "longitude": lon[::stride].tolist(), "values": safe,
                           "sampling": "nearest gridpoint decimation; native model grid retained on disk"})


def serve(pipeline, host, port):
    server = ThreadingHTTPServer((host, port), partial(Handler, pipeline=pipeline))
    print(f"Model Viewer catalog: http://{host}:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
