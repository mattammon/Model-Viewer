# Model Viewer

A global forecast explorer with a Python worker that gathers forecast output,
preserves individual ensemble members, and compiles gridded statistics.
Python 3.11+ on Linux or macOS. No API keys or paid data subscription required
for these public-data subsets. No cloud hosting or continuous service is enabled
by downloading this project; run the worker locally or deploy it on a server.

## Forecast products

| Internal ID | Viewer product | Members | Download grid |
| --- | --- | ---: | --- |
| `gefs` | NOAA GEFS | 0 control + 1–30 perturbed | 0.50° |
| `gfs` | NOAA operational GFS deterministic | 1 | 0.25° |
| `ifs_ens` | ECMWF IFS ensemble | 0 control + 1–50 perturbed | 0.25° |
| `ifs` | ECMWF operational IFS / former HRES | 1 | 0.25° |
| `aifs_ens` | ECMWF AIFS ensemble | 0 control + 1–50 perturbed | 0.25° |
| `aifs` | ECMWF AIFS Single deterministic | 1 | 0.25° |

These are public dissemination grids, not the models' native computational grids.
All six have 00, 06, 12, and 18 UTC initializations. Availability is discovered
from published indices rather than inferred solely from a fixed release delay.
Individual streams can therefore use different latest cycles. AIFS is a learned
forecast system, included alongside the conventional NWP products.

**Current IFS control handling matters:** starting with the 06 UTC cycle on
12 May 2026 (IFS 50r1), ECMWF disseminates the ensemble control via
`stream=oper,type=fc`; this is also the operational deterministic product.
The adapter obtains it there and assigns the local ensemble role `member=0`.
It does not look for a nonexistent modern `enfo/cf` record, require a
`perturbationNumber` on `oper/fc`, or include the deterministic forecast twice
in the 51-member ensemble. The deterministic product remains a separate viewer
selection, with the same values as that ensemble control. Earlier IFS cycles
use the historical layout. GEFS control is distinct from GFS; AIFS control is
distinct from AIFS Single.

## Start

```bash
cd model-viewer
python3 -m venv .venv
source .venv/bin/activate
python -m pip install '.[processing]'

# Inspect the latest usable cycle of every stream; downloads indices only.
python -m nwp_ingest --config config/smoke.json discover

# Small end-to-end live run: six fields, lead 24 h, two members per ensemble.
python -m nwp_ingest --config config/smoke.json sync

# Forecast map, ingestion status, and data API.
python -m nwp_ingest --config config/smoke.json serve
```

Open http://127.0.0.1:8080. Select a model, initialization, field, and product.
Use the forecast timeline to step through available leads or play them in a loop.
The domain menu includes global and regional views. Drag to pan, scroll or use
the zoom buttons, and click the map to sample the nearest source gridpoint.
The map uses a sampled latitude/longitude grid, with a fixed color scale for
each field and statistic so frames can be compared across leads. The point
inspector samples the full-resolution grid. Visit `/status` for ingestion details.

The smoke profile has only one lead and two members per ensemble. The viewer
shows the configured member count next to the full ensemble size. Use the
starter profile for a multi-lead view and the full ensemble statistics.

For continuous operational ingestion, use the same profile for the worker
and the monitor, in separate terminals:

```bash
python -m nwp_ingest --config config/starter.json watch
python -m nwp_ingest --config config/starter.json serve
```

The worker polls every 15 minutes, resumes incomplete cycles, and handles
SIGTERM/SIGINT between polls. An in-flight poll finishes before shutdown.
It must stay running for updates to continue. There is no ChatGPT background
task or remotely hosted collector associated with this download.

### Docker

```bash
docker compose up --build -d
docker compose logs -f ingest
```

Both services share the named `model-data` volume. The monitor is bound to
localhost port 8080. Data survive container restarts. To use another profile,
change the config argument in **both** services. A Linux systemd worker template
is supplied in `deploy/nwp-ingest.service`; adjust its user and paths first.
Docker and systemd examples require a machine where you can run persistent
processes; they are not intended for a browser-only or Cloudflare Worker runtime.

### Git history

The project archive includes a portable Git bundle. After extracting it,
clone the bundle to get the `main` branch and both the ingestion and viewer
commits.

```bash
git clone model-viewer.bundle model-viewer-git
cd model-viewer-git
docker compose up --build -d
```

The bundle contains the tracked source and history. Forecast data is stored
in the local data directory or Docker volume.

## Profiles and initial fields

| Profile | Forecast leads | Ensemble members | Purpose |
| --- | --- | --- | --- |
| `config/smoke.json` | 24 h | 0 and 1 | Fast adapter/processing check |
| `config/starter.json` | 0–72 h every 6 h | All | Initial global viewer dataset |
| `config/operational.json` | 0–360 h every 6 h, within each stream's horizon | All | Medium-range viewer dataset |

The framework retains **four latest discovered cycles per model**, plus its
latest downloaded and compiled fallback cycles if those fall outside the four. Set `retain_cycles`
to change this. Pruning touches only tracked forecast-cycle directories within
this profile's dataset, not unrelated files. A long outage can leave old
partial cycles; they are pruned as new cycles are ingested.

| Field | Description | Stored units |
| --- | --- | --- |
| `t2m` | 2 m temperature | K |
| `mslp` | Mean sea level pressure | Pa |
| `u10`, `v10` | 10 m wind components | m s⁻¹ |
| `z500` | 500 hPa geopotential height | m |
| `t850` | 850 hPa temperature | K |
| `ws10` | Derived 10 m wind speed | m s⁻¹ |

ECMWF geopotential is divided by 9.80665 when height is not directly available.
Normalized latitude increases south to north and longitude increases from
−180° to <180°. Each product retains its downloaded horizontal grid: GEFS is
not silently interpolated to the ECMWF/GFS grid. Cross-model differences will
need explicit regridding in a later layer.

Edit the JSON config to select models, fields, leads, and members. Example:

```json
{
  "models": ["gefs", "gfs", "ifs_ens", "ifs", "aifs_ens", "aifs"],
  "fields": ["t2m", "mslp", "u10", "v10", "z500", "t850"],
  "leads": [0, 6, 12, 24, 48, 72],
  "members": {},
  "workers": 4,
  "lookback_hours": 48,
  "poll_seconds": 900,
  "retain_cycles": 4
}
```

Empty `members` means all available members. To select a subset, for example,
set `"members": {"ifs_ens": [0, 1, 2, 3]}`. Supported leads are multiples of six.
The 15-day profile uses 360 h for comparison; NOAA adapters also support 366,
372, 378, and 384 h. IFS 00/12 cycles reach 360 h; 06/18 cycles reach 144 h.
AIFS reaches 360 h at all four cycles. GEFS extended-range 00 UTC output beyond
384 h is outside this first version. The newer 0.1° IFS dissemination is also
outside this initial adapter, which deliberately uses the combined 0.25° files.

## Ingestion behavior

1. Discover the newest cycle containing the selected fields at the first
   requested lead. Discovery is independent per model.
2. Plan the exact configured leads and members in SQLite. A complete cycle
   means complete for this configured selection, not all upstream products.
3. Fetch indices and select exact parameters, pressure levels, and members.
   ECMWF indices are shared across threads to avoid reading the same large
   ensemble index repeatedly. Indices are refreshed on the next poll.
4. Download just the required GRIB byte ranges, validate HTTP Content-Range
   and GRIB2 framing, and atomically register the completed shard with SHA-256
   and source provenance. Transient requests retry with bounded backoff;
   NOAA and ECMWF adapters each provide a secondary mirror.
5. Reuse verified files; retry pending and failed shards in subsequent polls.
   Existing incomplete recent cycles remain eligible after a newer run starts.
6. Decode and validate initialization, forecast lead, and ensemble member;
   normalize coordinates and units. Ingestion can run without decoding using
   `sync --raw-only` or `watch --raw-only`.
7. Compile each lead only after **every configured member** has downloaded.
   Publish an atomic JSON catalog distinguishing `latest_started`,
   `latest_downloaded`, and `latest_complete` (downloaded and compiled),
   with separate downloaded and compiled lead lists.

Ensemble outputs contain arithmetic mean, population standard deviation
(`ddof=0`), p10/p50/p90 using linear interpolation, and gridpoint member count.
NaN is retained where any configured member is missing at a grid cell.
Wind speed is calculated for each member **before** its ensemble statistics;
the mean wind speed is not replaced by the magnitude of mean u/v.
The control is included with equal weight. Disk-backed per-field member arrays
and tiled quantiles limit working memory. Original member files remain available.

`sync` exit codes: 0 = requested current work completed; 1 = discovery,
download, or processing error; 2 = upstream shards still pending. A successful
download status does not imply successful compilation; inspect `compiled_leads`
as well. Watch mode logs errors and retries on the next poll. A profile-level
OS writer lock prevents overlapping sync/compile writers; the API can read
atomic completed products concurrently.

## Data layout

```text
data/<selection-id>/
  config.json
  catalog.sqlite
  catalog.json
  last_sync.json
  raw/<model>/<cycle>/f024/m00.grib2
  raw/<model>/<cycle>/f024/m00.json
  normalized/<model>/<cycle>/f024/m00.npz
  normalized/<model>/<cycle>/f024/m00.json
  compiled/<model>/<cycle>/f024.npz
  compiled/<model>/<cycle>/f024.json
```

The selection ID hashes models, fields, leads, and members so a partial
configuration cannot masquerade as a more complete one. Changing those choices
creates a separate namespace. Worker interval, concurrency, and retention
changes reuse the same namespace. Override the parent with `--data-root PATH`
**before** the subcommand.

NPZ files can be read with NumPy without requiring xarray/cfgrib:

```python
import numpy as np

with np.load("data/SELECTION/compiled/ifs_ens/20261029T00Z/f024.npz") as ds:
    lat = ds["latitude"]
    lon = ds["longitude"]
    temperature_c = ds["t2m__mean"] - 273.15
    spread_k = ds["t2m__spread"]
    wind_p90 = ds["ws10__p90"]
```

Deterministic compiled fields use `t2m`, `u10`, etc., without statistic suffixes.
Ensemble fields use `t2m__mean`, `t2m__spread`, `t2m__p10`, `t2m__p50`,
`t2m__p90`, and `t2m__member_count`, and the same suffixes for other fields.
Each JSON sidecar includes units, valid time, member list, processing metadata,
and whether the full nominal ensemble was selected.

## Data API

The server is a local development/data interface, not an authenticated internet
service. It defaults to loopback. Use a proper application server, access
controls, and a suitable data-serving layer for a public deployment.

| Endpoint | Result |
| --- | --- |
| `/api/catalog` | Models, latest cycles, completeness, compiled leads, recent sync errors |
| `/health` | Catalog age and freshness |
| `/api/field?model=ifs_ens&cycle=20261029T00Z&lead=24&field=t2m&stat=mean&width=360` | Bounded decimated global field JSON |
| `/api/point?model=ifs_ens&cycle=20261029T00Z&lead=24&field=ws10&stat=p90&lat=35.2&lon=-97.4` | Nearest gridpoint value and product metadata |

Use a cycle from your actual catalog in those example URLs. No query silently
substitutes another cycle. Add `member=1` to a field or point request to read
that normalized ensemble member instead of a compiled statistic. API requests
read existing local files. Missing values are serialized as JSON null.
The field endpoint samples grid points for a small response, not a conservative
spatial average. The point endpoint uses nearest-gridpoint sampling, not
interpolation. The viewer refreshes its catalog once per minute.

## Practical resource considerations

Global individual-member ingestion is substantially larger than downloading
ensemble means. The starter profile has 13 leads × (31+1+51+1+51+1) = 1,768
shards per cycle when all six models share a cycle. The operational profile
has up to 8,296 shards for a 00/12 UTC cycle. Each shard contains six selected
GRIB fields. Exact sizes depend on model, field packing, and weather.

Raw, normalized, and summary products are all retained; allow several times
the raw transfer volume on disk. Full global member collections can reach tens
of GB per cycle even with this small set of fields. Start with the smoke profile, inspect actual
disk usage, then enable the global all-member worker. An ordinary persistent
Linux machine with SSD storage is appropriate for initial use; the worker does
not require GPUs. NPZ is intentionally simple for the first backend. For
multi-user map serving, migrate the compiled layer to tiled/chunked Zarr or
COG/tiles and object storage rather than serving entire arrays repeatedly.

## Checks

```bash
python -m unittest discover -s tests -v
python -m compileall -q nwp_ingest
```

The included tests cover exact level selection, shared GRIB offsets, IFS 50r1
control mapping, ensemble-member separation, concurrent index caching,
cycle rounding, framing errors, mirror failover, cache integrity, missing
products, writer locking, configuration isolation, and ensemble statistics.
See `VALIDATION.md` for the live checks actually performed for this release.

## Sources and attribution

Map linework comes from the public-domain Natural Earth 1:110 million scale
coastline, land boundaries, and state/province boundaries (v5.1.2). The viewer
ships only the coordinates needed to draw those lines.
[Natural Earth](https://www.naturalearthdata.com/).

Product definitions and operational changes were checked against primary
sources on 29 October 2026:

- [ECMWF open-data product descriptions](https://www.ecmwf.int/en/forecasts/datasets/open-data)
- [IFS 50r1 implementation and control-forecast changes](https://confluence.ecmwf.int/spaces/FCST/pages/567162191/Implementation+of+IFS+Cycle+50r1)
- [ECMWF open-data technical documentation](https://confluence.ecmwf.int/pages/viewpage.action?pageId=716102473)
- [Official ECMWF open-data client's source and conventions](https://github.com/ecmwf/ecmwf-opendata)
- [NOAA GEFS product inventory](https://www.nco.ncep.noaa.gov/pmb/products/gens/)
- [NOAA GEFS system description](https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gefs.php)

ECMWF open data are licensed under CC BY 4.0 and require appropriate attribution
when used or redistributed. The source URLs, initialization, processing choices,
and hashes are retained alongside downloaded and derived products.
