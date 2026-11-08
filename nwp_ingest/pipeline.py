from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import logging
import os
from pathlib import Path
import tempfile
from .catalog import Catalog, atomic_json, sha256, utcnow
from .http import HTTP, Missing, validate_grib
from .models import MODELS, cycles, cycle_id, parse_cycle, selected_members
from .providers import IndexCache, urls, select_messages

LOG = logging.getLogger(__name__)


@contextmanager
def writer_lock(root):
    # Advisory OS lock releases automatically after crashes; supported on Linux/macOS.
    import fcntl
    Path(root).mkdir(parents=True, exist_ok=True)
    with (Path(root) / ".writer.lock").open("w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("Another ingest/compile process owns this dataset") from exc
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


class Pipeline:
    def __init__(self, config, data_root, http=None):
        self.config = config
        self.root = Path(data_root).resolve() / config["selection_id"]
        self.catalog = Catalog(self.root)
        if not (self.root / "config.json").exists():
            atomic_json(self.root / "config.json", config)
        self.http = http or HTTP()
        self.indices = IndexCache(self.http)

    def locate(self, model, cycle, lead, member, fields):
        failures = []
        missing = True
        for data_url, index_url in urls(model, cycle, lead, member):
            try:
                entries = self.indices.get(index_url, model.provider)
                return data_url, index_url, select_messages(entries, model, member, fields, cycle)
            except Missing as exc:
                failures.append(str(exc))
            except Exception as exc:
                missing = False
                failures.append(f"{index_url}: {exc}")
        if missing:
            raise Missing("; ".join(failures))
        raise RuntimeError("; ".join(failures))

    def discover(self, name, fixed_cycle=None):
        model = MODELS[name]
        member = selected_members(self.config, model)[0]
        if fixed_cycle:
            return fixed_cycle
        failures = []
        for cycle in cycles(lookback_hours=self.config["lookback_hours"]):
            try:
                self.locate(model, cycle, min(self.config["leads"]), member, self.config["fields"])
                return cycle
            except Missing:
                continue
            except Exception as exc:
                failures.append(str(exc))
                continue
        if failures:
            raise RuntimeError(f"No usable {name} cycle; provider errors included: {failures[0]}")
        raise Missing(f"No available {name} cycle in lookback window")

    def plan(self, name, cycle):
        model = MODELS[name]
        leads = [lead for lead in self.config["leads"] if lead <= model.max_lead(cycle)]
        if not leads:
            raise ValueError(f"No requested leads within {name} forecast horizon")
        self.catalog.plan(name, cycle_id(cycle), leads, selected_members(self.config, model))

    def download(self, job):
        if self.catalog.valid(job):
            return "cached"
        model, cycle = MODELS[job["model"]], parse_cycle(job["cycle"])
        target = self.root / "raw" / model.id / job["cycle"] / f"f{job['lead']:03d}" / f"m{job['member']:02d}.grib2"
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = None
        try:
            errors, all_missing = [], True
            for url, index_url in urls(model, cycle, job["lead"], job["member"]):
                try:
                    entries = self.indices.get(index_url, model.provider)
                    chosen = select_messages(entries, model, job["member"], self.config["fields"], cycle)
                    # A field can share a GRIB2 message offset with another field.
                    ranges = sorted({(m.start, m.end) for m in chosen.values()}, key=lambda x: x[0])
                    fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".grib-")
                    tmp = Path(tmp_name)
                    with os.fdopen(fd, "wb") as output:
                        for start, end in ranges:
                            data = self.http.get(url, start, end)
                            validate_grib(data)
                            output.write(data)
                    break
                except Exception as exc:
                    errors.append(str(exc))
                    all_missing = all_missing and isinstance(exc, Missing)
                    if tmp:
                        tmp.unlink(missing_ok=True)
            else:
                raise (Missing if all_missing else RuntimeError)("; ".join(errors))
            os.replace(tmp, target)
            atomic_json(target.with_suffix(".json"), {
                "model": model.id, "cycle": job["cycle"], "lead": job["lead"], "member": job["member"],
                "source": url, "index": index_url, "downloaded_at": utcnow(),
                "fields": {name: msg.metadata for name, msg in chosen.items()},
                "sha256": sha256(target)})
            self.catalog.update(job, status="complete", path=str(target.relative_to(self.root)), size=target.stat().st_size,
                                sha256=sha256(target), source=url, error=None)
            return "downloaded"
        except Missing as exc:
            self.catalog.update(job, status="pending", error=str(exc), size=None)
            return "pending"
        except Exception as exc:
            self.catalog.update(job, status="failed", error=str(exc), size=None)
            LOG.warning("%s %s f%03d m%02d: %s", model.id, job["cycle"], job["lead"], job["member"], exc)
            return "failed"
        finally:
            if tmp:
                tmp.unlink(missing_ok=True)

    def sync(self, fixed_cycle=None, process=True):
        self.indices = IndexCache(self.http)
        with writer_lock(self.root):
            errors = []
            with ThreadPoolExecutor(max_workers=self.config["workers"]) as pool:
                discovery = {pool.submit(self.discover, n, fixed_cycle): n for n in self.config["models"]}
                for future in as_completed(discovery):
                    name = discovery[future]
                    try:
                        cycle = future.result()
                        self.plan(name, cycle)
                        LOG.info("%s latest requested cycle: %s", name, cycle_id(cycle))
                    except Exception as exc:
                        errors.append({"model": name, "error": str(exc)})
                        LOG.error("Discovery %s: %s", name, exc)
            cutoff = datetime.now(timezone.utc) - timedelta(hours=self.config["lookback_hours"])
            jobs = [j for j in self.catalog.jobs() if fixed_cycle and j["cycle"] == cycle_id(fixed_cycle)
                    or not fixed_cycle and parse_cycle(j["cycle"]) >= cutoff]
            counts = {"cached": 0, "downloaded": 0, "pending": 0, "failed": 0}
            with ThreadPoolExecutor(max_workers=self.config["workers"]) as pool:
                futures = [pool.submit(self.download, j) for j in jobs]
                for future in as_completed(futures):
                    counts[future.result()] += 1
            result = self.catalog.export(self.config)
            if process:
                from .processing import compile_available
                try:
                    compile_available(self.catalog, self.config)
                except Exception as exc:
                    LOG.exception("Compilation failed")
                    errors.append({"stage": "compilation", "error": str(exc)})
            self.catalog.prune(self.config["retain_cycles"])
            result = self.catalog.export(self.config)
            atomic_json(self.root / "last_sync.json", {"finished_at": utcnow(), "counts": counts, "discovery_errors": [e for e in errors if "model" in e],
                                                       "processing_errors": [e for e in errors if "stage" in e]})
            LOG.info("Sync finished: %s", json.dumps(counts))
            return result, counts, errors
