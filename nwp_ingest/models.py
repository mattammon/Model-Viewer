from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
from .climatology import REFERENCE_BOUNDS


@dataclass(frozen=True)
class Field:
    name: str
    units: str
    noaa_var: str
    noaa_level: str
    ecmwf_param: tuple[str, ...]
    level: int | None = None


FIELDS = {
    "t2m": Field("t2m", "K", "TMP", "2 m above ground", ("2t",)),
    "mslp": Field("mslp", "Pa", "PRMSL", "mean sea level", ("msl",)),
    "u10": Field("u10", "m s-1", "UGRD", "10 m above ground", ("10u",)),
    "v10": Field("v10", "m s-1", "VGRD", "10 m above ground", ("10v",)),
    "z500": Field("z500", "m", "HGT", "500 mb", ("gh", "z"), 500),
    "u850": Field("u850", "m s-1", "UGRD", "850 mb", ("u",), 850),
    "v850": Field("v850", "m s-1", "VGRD", "850 mb", ("v",), 850),
    "u100": Field("u100", "m s-1", "UGRD", "100 m above ground", ("100u",)),
    "v100": Field("v100", "m s-1", "VGRD", "100 m above ground", ("100v",)),
    "t850": Field("t850", "K", "TMP", "850 mb", ("t",), 850),
}


WIND_COMPONENTS = {
    "10": ("u10", "v10"),
    "100": ("u100", "v100"),
    "850": ("u850", "v850"),
}


def product_fields(config):
    fields = {name: FIELDS[name].units for name in config["fields"]}
    bounds = config.get("bounds")
    if bounds and "z500" in fields:
        west, east, south, north = bounds
        w, e, s, n = REFERENCE_BOUNDS
        if w <= west < east <= e and s <= south < north <= n:
            fields["z500_anom"] = "m"
    for suffix, (u, v) in WIND_COMPONENTS.items():
        if {u, v} <= fields.keys():
            fields["ws" + suffix] = "m s-1"
            if bounds is not None:
                fields["wd" + suffix] = "degree"
                del fields[u], fields[v]
    return fields


@dataclass(frozen=True)
class Model:
    id: str
    label: str
    provider: str
    ensemble: bool
    size: int
    resolution: str
    remote_model: str = ""

    def members(self):
        return list(range(self.size)) if self.ensemble else [0]

    def max_lead(self, cycle):
        if self.id in ("gfs", "gefs"):
            return 384
        if self.id.startswith("aifs"):
            return 360
        if self.id == "ifs":
            if cycle.strftime("%Y%m%d") >= "20260512":
                return 360 if cycle.hour in (0, 12) else 144
            return 240 if cycle.hour in (0, 12) else 90
        return 360 if cycle.hour in (0, 12) else 144


MODELS = {
    "gefs": Model("gefs", "GEFS", "noaa", True, 31, "0p50"),
    "gfs": Model("gfs", "GFS deterministic", "noaa", False, 1, "0p25"),
    "ifs_ens": Model("ifs_ens", "ECMWF IFS ENS", "ecmwf", True, 51, "0p25", "ifs"),
    "ifs": Model("ifs", "ECMWF IFS deterministic", "ecmwf", False, 1, "0p25", "ifs"),
    "aifs_ens": Model("aifs_ens", "ECMWF AIFS ENS", "ecmwf", True, 51, "0p25", "aifs-ens"),
    "aifs": Model("aifs", "ECMWF AIFS Single", "ecmwf", False, 1, "0p25", "aifs-single"),
}


def cycle_id(cycle):
    return cycle.strftime("%Y%m%dT%HZ")


def parse_cycle(value):
    return datetime.strptime(value, "%Y%m%dT%HZ").replace(tzinfo=timezone.utc)


def ifs_control_is_oper(model, cycle, member):
    """50r1 merges the separately disseminated IFS control and former HRES."""
    return (model.id == "ifs_ens" and member == 0 and cycle is not None
            and cycle >= parse_cycle("20260512T06Z"))


def cycles(now=None, lookback_hours=48):
    now = now or datetime.now(timezone.utc)
    start = now.replace(hour=(now.hour // 6) * 6, minute=0, second=0, microsecond=0)
    return [start - timedelta(hours=h) for h in range(0, lookback_hours + 1, 6)]



def validated_bounds(bounds, name, limits=(-180, 180, -90, 90)):
    if (not isinstance(bounds, list) or len(bounds) != 4
            or any(type(value) not in (int, float) or not math.isfinite(value) for value in bounds)):
        raise ValueError(f"{name} must be [west, east, south, north] in degrees")
    west, east, south, north = bounds
    w, e, s, n = limits
    if not (w <= west < east <= e and s <= south < north <= n):
        raise ValueError(f"{name} must be ordered and within its domain")
    return [float(value) for value in bounds]


def selected_cycle_hours(config, model):
    return config.get("cycle_hours", {}).get(model, [0, 6, 12, 18])

def load_config(path):
    config = json.loads(Path(path).read_text())
    for name in config["models"]:
        if name not in MODELS:
            raise ValueError(f"Unknown model: {name}")
    if not config["models"] or not config["fields"] or not config["leads"]:
        raise ValueError("models, fields and leads must be nonempty")
    if len(set(config["models"])) != len(config["models"]):
        raise ValueError("Duplicate models")
    if len(set(config["fields"])) != len(config["fields"]):
        raise ValueError("Duplicate fields")
    for name in config["fields"]:
        if name not in FIELDS:
            raise ValueError(f"Unknown field: {name}")
    config["leads"] = sorted(set(config["leads"]))
    if any(type(h) is not int or h < 0 or h > 384 or h % 6 for h in config["leads"]):
        raise ValueError("Lead hours must be multiples of six in 0..384")
    for name in config["models"]:
        selected_members(config, MODELS[name])
    config.setdefault("workers", 4)
    config.setdefault("lookback_hours", 48)
    config.setdefault("poll_seconds", 900)
    config.setdefault("retain_cycles", 4)
    if not 1 <= config["workers"] <= 16 or config["poll_seconds"] < 60:
        raise ValueError("workers must be 1..16; poll_seconds must be >=60")
    if type(config["retain_cycles"]) is not int or config["retain_cycles"] < 1:
        raise ValueError("retain_cycles must be a positive integer")
    # Fields and member selections define an independent catalog namespace.
    selection = {k: config.get(k) for k in ("fields", "members", "leads", "models")}
    if "bounds" in config:
        selection["bounds"] = validated_bounds(config["bounds"], "bounds")
    if "member_wind_bounds" in config:
        if "bounds" not in config or any(not MODELS[name].ensemble for name in config["models"]):
            raise ValueError("member_wind_bounds requires a regional ensemble dataset")
        if not {"u10", "v10", "u100", "v100"} <= set(config["fields"]):
            raise ValueError("member_wind_bounds requires the 10 m and 100 m wind components")
        selection["member_wind_bounds"] = validated_bounds(config["member_wind_bounds"], "member_wind_bounds", config["bounds"])
    if "cycle_hours" in config:
        cycle_hours = config["cycle_hours"]
        if not isinstance(cycle_hours, dict) or not cycle_hours.keys() <= set(config["models"]):
            raise ValueError("cycle_hours must map configured models to UTC initialization hours")
        for name, hours in cycle_hours.items():
            if (not isinstance(hours, list) or not hours
                    or any(type(hour) is not int or hour not in (0, 6, 12, 18) for hour in hours)):
                raise ValueError(f"Invalid cycle_hours for {name}")
        selection["cycle_hours"] = {name: sorted(set(hours)) for name, hours in cycle_hours.items()}
    config["selection_id"] = hashlib.sha256(json.dumps(selection, sort_keys=True).encode()).hexdigest()[:12]
    return config


def selected_members(config, model):
    value = config.get("members", {}).get(model.id, "all")
    result = model.members() if value == "all" else sorted(set(value))
    if not result or any(type(m) is not int or m not in model.members() for m in result):
        raise ValueError(f"Invalid members for {model.id}: {value}")
    return result
