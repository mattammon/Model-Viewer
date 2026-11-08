from concurrent.futures import Future
from dataclasses import dataclass
import json
import threading
from .http import Missing
from .models import FIELDS, ifs_control_is_oper


@dataclass(frozen=True)
class Message:
    start: int
    end: int | None
    metadata: dict


def noaa_index(text):
    entries = []
    for line in text.splitlines():
        parts = line.split(":")
        if len(parts) >= 6:
            entries.append((int(parts[1]), {"param": parts[3], "level": parts[4], "description": line}))
    offsets = sorted({offset for offset, _ in entries})
    ends = {n: offsets[i + 1] - 1 if i + 1 < len(offsets) else None for i, n in enumerate(offsets)}
    return [Message(n, ends[n], meta) for n, meta in entries]


def ecmwf_index(text):
    result = []
    for line in text.splitlines():
        if line.strip():
            m = json.loads(line)
            offset, length = int(m["_offset"]), int(m["_length"])
            if offset < 0 or length <= 0:
                raise ValueError("Invalid ECMWF index range")
            result.append(Message(offset, offset + length - 1, m))
    return result


def select_messages(entries, model, member, fields, cycle=None):
    chosen = {}
    for name in fields:
        field = FIELDS[name]
        matches = []
        for msg in entries:
            m = msg.metadata
            if model.provider == "noaa":
                ok = m["param"] == field.noaa_var and m["level"] == field.noaa_level
            else:
                ok = m.get("param") in field.ecmwf_param
                ok = ok and (str(m.get("levelist")) == str(field.level) if field.level else m.get("levtype") == "sfc")
                if model.ensemble:
                    if ifs_control_is_oper(model, cycle, member):
                        ok = ok and m.get("type") == "fc"
                    else:
                        ok = ok and (m.get("type") == "cf" if member == 0 else m.get("type") == "pf" and str(m.get("number")) == str(member))
                else:
                    ok = ok and m.get("type") in ("fc", "fcmean")
            if ok:
                matches.append(msg)
        if not matches:
            raise Missing(f"{model.id} member {member}: {name} not yet in index")
        # Prefer height over geopotential when both are present.
        matches.sort(key=lambda m: (m.metadata.get("param") == "z", m.start))
        chosen[name] = matches[0]
    return chosen


def urls(model, cycle, lead, member):
    date, hour = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    if model.provider == "noaa":
        if model.id == "gfs":
            key = f"gfs.{date}/{hour}/atmos/gfs.t{hour}z.pgrb2.0p25.f{lead:03d}"
            roots = ["https://noaa-gfs-bdp-pds.s3.amazonaws.com", "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"]
        else:
            tag = "gec00" if member == 0 else f"gep{member:02d}"
            key = f"gefs.{date}/{hour}/atmos/pgrb2ap5/{tag}.t{hour}z.pgrb2a.0p50.f{lead:03d}"
            roots = ["https://noaa-gefs-pds.s3.amazonaws.com", "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gens/prod"]
        return [(f"{root}/{key}", f"{root}/{key}.idx") for root in roots]
    merged_control = ifs_control_is_oper(model, cycle, member)
    stream = "enfo" if model.ensemble and not merged_control else "oper"
    if model.id == "ifs" and cycle.strftime("%Y%m%d") < "20260512" and cycle.hour in (6, 18):
        stream = "scda"
    kind = ("cf" if member == 0 else "pf") if model.id == "aifs_ens" else ("ef" if model.ensemble and not merged_control else "fc")
    stem = f"{date}/{hour}z/{model.remote_model}/0p25/{stream}/{date}{hour}0000-{lead}h-{stream}-{kind}"
    return [(f"{root}/{stem}.grib2", f"{root}/{stem}.index") for root in (
        "https://data.ecmwf.int/forecasts", "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com")]


class IndexCache:
    """Deduplicate concurrent ensemble index reads; recreate on every poll."""
    def __init__(self, http):
        self.http, self.cache, self.lock = http, {}, threading.Lock()

    def get(self, url, provider):
        with self.lock:
            owner = url not in self.cache
            if owner:
                self.cache[url] = Future()
            future = self.cache[url]
        if owner:
            try:
                text = self.http.get(url).decode()
                future.set_result(ecmwf_index(text) if provider == "ecmwf" else noaa_index(text))
            except Exception as exc:
                future.set_exception(exc)
        return future.result()
