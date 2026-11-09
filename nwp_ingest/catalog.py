from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
import shutil
from pathlib import Path
import sqlite3
import tempfile


def utcnow():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".write-")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(value, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


class Catalog:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        with self.db() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS jobs (
                model TEXT, cycle TEXT, lead INTEGER, member INTEGER,
                status TEXT NOT NULL DEFAULT 'pending', path TEXT,
                size INTEGER, sha256 TEXT, source TEXT, error TEXT,
                updated TEXT, PRIMARY KEY(model,cycle,lead,member))""")

    @contextmanager
    def db(self):
        db = sqlite3.connect(self.root / "catalog.sqlite", timeout=60)
        db.row_factory = sqlite3.Row
        try:
            yield db
            db.commit()
        finally:
            db.close()

    def plan(self, model, cycle, leads, members):
        with self.db() as db:
            db.executemany("INSERT OR IGNORE INTO jobs(model,cycle,lead,member,updated) VALUES(?,?,?,?,?)",
                           [(model, cycle, lead, m, utcnow()) for lead in leads for m in members])

    def jobs(self, model=None, cycle=None, lead=None):
        query, args = "SELECT * FROM jobs WHERE 1=1", []
        for key, value in (("model", model), ("cycle", cycle), ("lead", lead)):
            if value is not None:
                query += f" AND {key}=?"
                args.append(value)
        with self.db() as db:
            return [dict(row) for row in db.execute(query + " ORDER BY model,cycle DESC,lead,member", args)]

    def update(self, job, **values):
        values["updated"] = utcnow()
        with self.db() as db:
            db.execute("UPDATE jobs SET " + ",".join(f"{k}=?" for k in values) + " WHERE model=? AND cycle=? AND lead=? AND member=?",
                       [*values.values(), *(job[k] for k in ("model", "cycle", "lead", "member"))])

    def valid(self, job):
        if job["status"] != "complete" or not job["path"]:
            return False
        path = self.root / job["path"]
        return (path.is_file() and (path.suffix != ".npz" or path.with_suffix(".json").is_file())
                and path.stat().st_size == job["size"] and sha256(path) == job["sha256"])

    def prune(self, retain_cycles, *, keep_fallback=True):
        """Remove old tracked forecast cycles, optionally keeping a usable fallback."""
        from .models import MODELS, parse_cycle
        grouped = {}
        for job in self.jobs():
            grouped.setdefault(job["model"], {}).setdefault(job["cycle"], []).append(job)
        for name, runs in grouped.items():
            if name not in MODELS:
                continue
            ordered = sorted(runs, reverse=True)
            keep = set(ordered[:retain_cycles])
            if keep_fallback:
                complete = [c for c in ordered if all(j["status"] == "complete" for j in runs[c])]
                if complete:
                    keep.add(complete[0])
                ready = [c for c in complete if all((self.root / "compiled" / name / c / f"f{lead:03d}.npz").exists()
                                                   for lead in {j["lead"] for j in runs[c]})]
                if ready:
                    keep.add(ready[0])
            for cycle in set(ordered) - keep:
                parse_cycle(cycle)  # Validate the tracked path component before removal.
                # The member_winds archive is retained independently of viewer cycles.
                for folder in ("raw", "normalized", "compiled"):
                    path = self.root / folder / name / cycle
                    if path.exists():
                        shutil.rmtree(path)
                with self.db() as db:
                    db.execute("DELETE FROM jobs WHERE model=? AND cycle=?", (name, cycle))

    def export(self, config):
        from .models import MODELS, product_fields
        groups, lead_states = {}, {}
        for job in self.jobs():
            key = (job["model"], job["cycle"])
            group = groups.setdefault(key, {"model": key[0], "cycle": key[1], "expected": 0, "complete": 0, "pending": 0, "failed": 0, "bytes": 0, "leads": set(), "complete_leads": [], "errors": []})
            group["expected"] += 1
            group[job["status"]] += 1
            group["bytes"] += job["size"] or 0
            group["leads"].add(job["lead"])
            lead_key = (*key, job["lead"])
            lead_states[lead_key] = lead_states.get(lead_key, True) and job["status"] == "complete"
            if job["error"] and len(group["errors"]) < 3:
                group["errors"].append(job["error"])
        for key, g in groups.items():
            g["leads"] = sorted(g["leads"])
            for lead in g["leads"]:
                if lead_states[(*key, lead)]:
                    g["complete_leads"].append(lead)
            g["download_complete"] = g["complete"] == g["expected"]
            compiled = self.root / "compiled" / key[0] / key[1]
            if "member_wind_bounds" in config:
                archive = self.root / "member_winds" / key[0] / key[1]
                g["compiled_leads"] = [lead for lead in g["complete_leads"]
                                       if (compiled / f"f{lead:03d}.npz").is_file()
                                       and (compiled / f"f{lead:03d}.json").is_file()
                                       and (archive / f"f{lead:03d}.npz").is_file()]
            else:
                g["compiled_leads"] = sorted(int(p.stem[1:]) for p in compiled.glob("f*.npz"))
            g["status"] = "complete" if g["download_complete"] and set(g["compiled_leads"]) == set(g["leads"]) else "partial"
        models = []
        for name in config["models"]:
            model = MODELS[name]
            runs = sorted([g for (mid, _), g in groups.items() if mid == name], key=lambda g: g["cycle"], reverse=True)
            complete = [g for g in runs if g["status"] == "complete"]
            downloaded = [g for g in runs if g["download_complete"]]
            models.append({"id": name, "label": model.label, "ensemble": model.ensemble,
                           "resolution": model.resolution, "latest_started": runs[0]["cycle"] if runs else None,
                           "latest_complete": complete[0]["cycle"] if complete else None, "runs": runs})
            models[-1]["latest_downloaded"] = downloaded[0]["cycle"] if downloaded else None
        result = {"schema_version": 1, "generated_at": utcnow(), "selection_id": config["selection_id"],
                  "fields": product_fields(config), "models": models,
                  "attribution": "ECMWF open data: CC BY 4.0. Contains modified Copernicus/ECMWF information where applicable. NOAA/NCEP forecasts."}
        if "bounds" in config:
            result["bounds"] = config["bounds"]
        if "member_wind_bounds" in config:
            result["member_wind_bounds"] = config["member_wind_bounds"]
        atomic_json(self.root / "catalog.json", result)
        return result
