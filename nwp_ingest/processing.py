"""Normalize global fields and compile member statistics one field at a time."""
from collections import defaultdict
from datetime import timedelta
import json
import logging
import os
from pathlib import Path
import tempfile
from .catalog import atomic_json, sha256
from .models import FIELDS, MODELS, parse_cycle, selected_members, ifs_control_is_oper

LOG = logging.getLogger(__name__)
PROCESSING_VERSION = 1


def require_processing():
    try:
        import numpy  # noqa: F401
        import eccodes  # noqa: F401
    except ImportError as exc:
        raise RuntimeError('Processing needs: pip install ".[processing]"; use --raw-only for GRIB ingestion alone') from exc


def atomic_npz(path, arrays):
    import numpy as np
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".npz-")
    try:
        with os.fdopen(fd, "wb") as f:
            np.savez_compressed(f, **arrays)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def normalize(raw, output, job, fields):
    import numpy as np
    import eccodes as ec
    info = output.with_suffix(".json")
    fingerprint = {"raw_sha256": job["sha256"], "version": PROCESSING_VERSION, "fields": fields}
    if output.exists() and info.exists() and json.loads(info.read_text()).get("fingerprint") == fingerprint:
        return
    aliases = {"t2m": {"2t"}, "mslp": {"msl", "prmsl"}, "u10": {"10u"}, "v10": {"10v"},
               "z500": {"z", "gh"}, "t850": {"t"}}
    data = {}
    ref_lat, ref_lon = None, None
    expected_cycle = parse_cycle(job["cycle"])
    with raw.open("rb") as f:
        while (gid := ec.codes_grib_new_from_file(f)) is not None:
            try:
                short = ec.codes_get(gid, "shortName")
                level = int(ec.codes_get(gid, "level"))
                level_type = ec.codes_get(gid, "typeOfLevel")
                candidates = [n for n in fields if short in aliases[n] and
                              (FIELDS[n].level is None or level_type == "isobaricInhPa" and level == FIELDS[n].level)]
                if not candidates:
                    continue
                # Detect mislabelled source output before registering normalized data.
                if int(ec.codes_get(gid, "dataDate")) != int(expected_cycle.strftime("%Y%m%d")) or int(ec.codes_get(gid, "dataTime")) != expected_cycle.hour * 100:
                    raise ValueError("GRIB initialization does not match requested cycle")
                if int(ec.codes_get(gid, "endStep")) != job["lead"]:
                    raise ValueError("GRIB forecast lead does not match request")
                if MODELS[job["model"]].ensemble and not ifs_control_is_oper(MODELS[job["model"]], expected_cycle, job["member"]):
                    if int(ec.codes_get(gid, "perturbationNumber")) != job["member"]:
                        raise ValueError("GRIB ensemble member does not match request")
                ni, nj = int(ec.codes_get(gid, "Ni")), int(ec.codes_get(gid, "Nj"))
                if ec.codes_get(gid, "gridType") != "regular_ll":
                    raise ValueError("Expected regular latitude/longitude grid")
                lats = np.asarray(ec.codes_get_array(gid, "latitudes")).reshape(nj, ni)
                lons = np.asarray(ec.codes_get_array(gid, "longitudes")).reshape(nj, ni)
                values = np.asarray(ec.codes_get_values(gid), dtype="float32").reshape(nj, ni)
                if not np.allclose(lats, lats[:, :1]) or not np.allclose(lons, lons[:1, :]):
                    raise ValueError("Unsupported scanning order")
                values[values == np.float32(ec.codes_get(gid, "missingValue"))] = np.nan
                lat_order = np.argsort(lats[:, 0])
                lon_1d = (lons[0] + 180) % 360 - 180
                lon_order = np.argsort(lon_1d)
                lat, lon = lats[lat_order, 0].astype("float32"), lon_1d[lon_order].astype("float32")
                if ref_lat is None:
                    ref_lat, ref_lon = lat, lon
                elif not np.array_equal(ref_lat, lat) or not np.array_equal(ref_lon, lon):
                    raise ValueError("Fields within one shard have different grids")
                for name in candidates:
                    array = values[lat_order][:, lon_order]
                    if name == "z500" and short == "z":
                        array = array / np.float32(9.80665)
                    if name in data:
                        raise ValueError(f"Duplicate field {name}")
                    data[name] = array
            finally:
                ec.codes_release(gid)
    missing = set(fields) - data.keys()
    if missing:
        raise ValueError(f"Missing decoded fields: {sorted(missing)}")
    if "u10" in data and "v10" in data:
        data["ws10"] = np.hypot(data["u10"], data["v10"])
    data.update(latitude=ref_lat, longitude=ref_lon)
    atomic_npz(output, data)
    atomic_json(info, {"fingerprint": fingerprint, "model": job["model"], "cycle": job["cycle"],
                      "lead": job["lead"], "member": job["member"],
                      "valid_time": (expected_cycle + timedelta(hours=job["lead"])).isoformat(),
                      "units": {**{n: FIELDS[n].units for n in fields}, **({"ws10": "m s-1"} if "ws10" in data else {})}})


def statistics(stack, tile_rows=32):
    """Bound memory by slicing a disk-backed (member, latitude, longitude) array."""
    import numpy as np
    shape = stack.shape[1:]
    result = {k: np.empty(shape, dtype="float32") for k in ("mean", "spread", "p10", "p50", "p90")}
    count = np.empty(shape, dtype="uint16")
    for start in range(0, shape[0], tile_rows):
        stop = min(start + tile_rows, shape[0])
        block = np.asarray(stack[:, start:stop, :])
        count[start:stop] = np.isfinite(block).sum(axis=0)
        # Publish NaN wherever any configured member is missing at a grid cell.
        good = count[start:stop] == stack.shape[0]
        mean = np.mean(block, axis=0, dtype="float64")
        spread = np.std(block, axis=0, ddof=0, dtype="float64")
        quantiles = np.quantile(block, [0.1, 0.5, 0.9], axis=0, method="linear")
        for name, values in zip(result, [mean, spread, *quantiles]):
            result[name][start:stop] = np.where(good, values, np.nan)
    result["member_count"] = count
    return result


def compile_available(catalog, config):
    require_processing()
    import numpy as np
    groups = defaultdict(list)
    for job in catalog.jobs():
        groups[(job["model"], job["cycle"], job["lead"])].append(job)
    for (name, cycle, lead), jobs in groups.items():
        if any(j["status"] != "complete" for j in jobs):
            continue
        expected = selected_members(config, MODELS[name])
        if sorted(j["member"] for j in jobs) != expected:
            continue
        jobs.sort(key=lambda j: j["member"])
        output = catalog.root / "compiled" / name / cycle / f"f{lead:03d}.npz"
        info = output.with_suffix(".json")
        fingerprint = {"members": expected, "raw_sha256": [j["sha256"] for j in jobs], "fields": config["fields"], "version": PROCESSING_VERSION}
        if output.exists() and info.exists() and json.loads(info.read_text()).get("fingerprint") == fingerprint:
            continue
        paths = []
        for job in jobs:
            raw = catalog.root / job["path"]
            if not catalog.valid(job):
                catalog.update(job, status="pending", error="Integrity check failed before compilation")
                break
            target = catalog.root / "normalized" / name / cycle / f"f{lead:03d}" / f"m{job['member']:02d}.npz"
            normalize(raw, target, job, config["fields"])
            paths.append(target)
        if len(paths) != len(jobs):
            continue
        with np.load(paths[0]) as first:
            lat, lon = first["latitude"], first["longitude"]
            names = [n for n in first.files if n not in ("latitude", "longitude")]
        arrays = {"latitude": lat, "longitude": lon}
        for field in names:
            if not MODELS[name].ensemble:
                with np.load(paths[0]) as first:
                    arrays[field] = first[field]
                continue
            # Temporary memory map avoids loading all members and variables together.
            output.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=output.parent, prefix=".ensemble-") as temp:
                stack = np.lib.format.open_memmap(Path(temp) / "stack.npy", mode="w+", dtype="float32", shape=(len(paths), len(lat), len(lon)))
                try:
                    for i, path in enumerate(paths):
                        with np.load(path) as member:
                            if not np.array_equal(lat, member["latitude"]) or not np.array_equal(lon, member["longitude"]):
                                raise ValueError("Ensemble members have different grids")
                            stack[i] = member[field]
                    for stat, values in statistics(stack).items():
                        arrays[f"{field}__{stat}"] = values
                finally:
                    del stack
        atomic_npz(output, arrays)
        atomic_json(info, {"fingerprint": fingerprint, "model": name, "cycle": cycle, "lead": lead,
                          "valid_time": (parse_cycle(cycle) + timedelta(hours=lead)).isoformat(),
                          "ensemble": MODELS[name].ensemble, "members": expected,
                          "nominal_ensemble_size": MODELS[name].size,
                          "control_source": "oper/fc (also the deterministic product)" if ifs_control_is_oper(MODELS[name], parse_cycle(cycle), 0) else "separate ensemble control" if MODELS[name].ensemble else None,
                          "full_ensemble": len(expected) == MODELS[name].size,
                          "spread_ddof": 0, "quantile_method": "linear", "ws10_method": "speed calculated per member before statistics",
                          "units": {**{n: FIELDS[n].units for n in config["fields"]}, **({"ws10": "m s-1"} if "ws10" in names else {})},
                          "sha256": sha256(output)})
        LOG.info("Compiled %s %s f%03d (%s members)", name, cycle, lead, len(paths))
