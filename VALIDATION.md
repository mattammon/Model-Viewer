# Regional-profile validation

Live tests used the 8 November 2026 12 UTC runs of IFS ENS and AIFS ENS,
with the control and member 1 at forecast hours 0 and 24. All four
lead/model combinations compiled. The retained member grids were 241 × 401
with inclusive bounds of 40°W–60°E and 20°N–80°N. The regional run produced
no raw GRIB files on disk.

The API checks covered regional model and field selection,
all three wind levels, wind direction for an individual member, rejection
of out-of-domain points, and height anomalies against the UTC valid-day
climatology. All 25 unit tests passed. The full 51-member profiles were
not benchmarked.

# Previous global-profile validation (29 October 2026)

The completed-cycle integration test used actual public forecast output initialized at **00 UTC on 29 October 2026**, valid at **00 UTC on 30 October 2026** (lead 24 hours). Each ensemble test selected its control and perturbed member 1; deterministic products used their single operational forecast. All six requested fields were downloaded and decoded.

| Product | Native downloaded array shape (latitude × longitude) | Compiled fields | Result |
| --- | --- | ---: | --- |
| aifs | 721 × 1440 | 7 | Passed |
| aifs_ens | 721 × 1440 | 42 | Passed |
| gefs | 361 × 720 | 42 | Passed |
| gfs | 721 × 1440 | 7 | Passed |
| ifs | 721 × 1440 | 7 | Passed |
| ifs_ens | 721 × 1440 | 42 | Passed |

Ensembles produce seven variables (the six input fields plus wind speed) × six statistical/count arrays = 42 fields; deterministic products produce seven variable arrays. Latitude/longitude coordinate arrays are additional.

- **21 automated tests passed.** Provider selection, IFS 50r1 control routing, mirror fallback, corruption detection, partial-run behavior, writer locking, retention, dateline sampling, strict JSON null handling, and statistics were checked.
- **Compilation succeeded for all six streams** in the completed-cycle test, including the IFS ensemble with its control fetched through `oper/fc`.
- **Resumption/idempotence passed:** a repeat completed-cycle sync returned nine cached shards, zero downloads, zero pending shards, and zero failures.
- **Automatic latest-cycle discovery passed for all six streams.** At an earlier check, NOAA/AIFS selected 12 UTC and IFS selected 06 UTC. Once IFS 12 UTC control appeared, discovery advanced to that cycle; an unavailable perturbed-member file remained pending rather than being treated as complete.
- **Local HTTP integration checks passed** against the real compiled data: health, six-model catalog, global field response, nearest-gridpoint response, and dashboard HTML returned HTTP 200. `examples/api_validation.json` contains the results.
- **Source compilation and editable package installation passed.** Dashboard JavaScript passed `node --check`.

## Verification limits

- The live integration tests used two members per ensemble, not complete 31-/51-member ensembles. Full-member collection is configured in the starter and operational profiles; its long-running throughput and resource use were not benchmarked here.
- The completed-cycle test sampled one forecast lead. The full 0–72 h and 15-day collections were not downloaded in this environment.
- The latest 12 UTC IFS ensemble was still partially released during validation. The included catalog captures the observed state; these example catalogs do not update themselves.
- Docker Compose and the systemd unit are supplied but were not launched on a persistent host. No continuous background collector or remotely hosted viewer has been deployed.
- Dashboard HTML and JavaScript were checked, and API behavior was tested; no browser-based visual QA was performed.

## Reproduce

```bash
python -m pip install '.[processing]'
python -m unittest discover -s tests -v
python -m nwp_ingest --config config/smoke.json discover
python -m nwp_ingest --config config/smoke.json sync
python -m nwp_ingest --config config/smoke.json sync
python -m nwp_ingest --config config/smoke.json serve
```

Use an explicit historical cycle only while that cycle remains in the upstream rolling archive. Forecast arrays from the tests are not embedded in this source archive; the source catalog/provenance and test results are included.
