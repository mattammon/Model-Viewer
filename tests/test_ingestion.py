from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from nwp_ingest.catalog import Catalog
from nwp_ingest.http import Missing, validate_grib
from nwp_ingest.models import MODELS, cycles, load_config, parse_cycle
from nwp_ingest.pipeline import Pipeline, writer_lock
from nwp_ingest.providers import IndexCache, ecmwf_index, noaa_index, select_messages, urls


def grib_frame(payload=b"test"):
    size = 20 + len(payload)
    return b"GRIB" + b"\0\0\0\2" + size.to_bytes(8, "big") + payload + b"7777"


class ProviderTests(unittest.TestCase):
    def test_noaa_exact_height_and_offsets(self):
        entries = noaa_index("1:0:d=2026102900:UGRD:10 mb:24 hour fcst:\n2:100:d=2026102900:UGRD:10 m above ground:24 hour fcst:\n3:200:d=2026102900:VGRD:10 m above ground:24 hour fcst:\n")
        selected = select_messages(entries, MODELS["gfs"], 0, ["u10", "v10"])
        self.assertEqual((selected["u10"].start, selected["u10"].end), (100, 199))
        self.assertIsNone(selected["v10"].end)

    def test_ecmwf_control_is_not_perturbed(self):
        rows = [{"_offset": 0, "_length": 100, "param": "2t", "levtype": "sfc", "type": "pf", "number": "1"},
                {"_offset": 100, "_length": 100, "param": "2t", "levtype": "sfc", "type": "cf"}]
        entries = ecmwf_index("\n".join(json.dumps(r) for r in rows))
        self.assertEqual(select_messages(entries, MODELS["ifs_ens"], 0, ["t2m"])["t2m"].start, 100)
        self.assertEqual(select_messages(entries, MODELS["ifs_ens"], 1, ["t2m"])["t2m"].start, 0)
        with self.assertRaises(Missing):
            select_messages(entries, MODELS["ifs_ens"], 2, ["t2m"])

    def test_height_preferred_and_pressure_level_exact(self):
        rows = [{"_offset": i * 100, "_length": 100, "param": p, "levelist": str(level), "levtype": "pl", "type": "fc"}
                for i, (p, level) in enumerate([("z", 500), ("gh", 850), ("gh", 500)])]
        entries = ecmwf_index("\n".join(json.dumps(r) for r in rows))
        self.assertEqual(select_messages(entries, MODELS["ifs"], 0, ["z500"])["z500"].start, 200)

    def test_model_urls_and_stream_transition(self):
        cycle = parse_cycle("20261029T06Z")
        self.assertIn("/06z/ifs/0p25/oper/", urls(MODELS["ifs"], cycle, 24, 0)[0][0])
        self.assertIn("-enfo-ef.index", urls(MODELS["ifs_ens"], cycle, 24, 1)[0][1])
        self.assertIn("-enfo-cf.index", urls(MODELS["aifs_ens"], cycle, 24, 0)[0][1])
        self.assertIn("-enfo-pf.index", urls(MODELS["aifs_ens"], cycle, 24, 1)[0][1])
        self.assertEqual(urls(MODELS["ifs_ens"], cycle, 24, 0), urls(MODELS["ifs"], cycle, 24, 0))
        self.assertIn("/scda/", urls(MODELS["ifs"], parse_cycle("20260429T06Z"), 24, 0)[0][0])
        self.assertNotIn("gec00", urls(MODELS["gfs"], cycle, 24, 0)[0][0])

    def test_ifs_merged_control_selects_oper_fc(self):
        entry = {"_offset": 0, "_length": 100, "param": "2t", "levtype": "sfc", "type": "fc"}
        entries = ecmwf_index(json.dumps(entry))
        self.assertEqual(select_messages(entries, MODELS["ifs_ens"], 0, ["t2m"], parse_cycle("20261029T00Z"))["t2m"].start, 0)
        with self.assertRaises(Missing):
            select_messages(entries, MODELS["ifs_ens"], 0, ["t2m"], parse_cycle("20260512T00Z"))

    def test_shared_noaa_offsets(self):
        entries = noaa_index("1:0:d=x:UGRD:10 m above ground:x\n2:0:d=x:VGRD:10 m above ground:x\n3:50:d=x:TMP:2 m above ground:x")
        self.assertEqual(entries[0].end, 49)
        self.assertEqual(entries[1].end, 49)

    def test_index_cache_one_fetch_with_concurrency(self):
        class HTTP:
            count = 0
            def get(self, _):
                self.count += 1
                return b'1:0:d=x:TMP:2 m above ground:x'
        http = HTTP()
        cache = IndexCache(http)
        with ThreadPoolExecutor(8) as pool:
            lists = list(pool.map(lambda _: cache.get("url", "noaa"), range(20)))
        self.assertEqual(http.count, 1)
        self.assertTrue(all(x == lists[0] for x in lists))

    def test_cycle_rounding_and_horizon(self):
        result = cycles(datetime(2026, 10, 29, 13, 52, tzinfo=timezone.utc), 12)
        self.assertEqual([x.hour for x in result], [12, 6, 0])
        self.assertEqual(MODELS["ifs"].max_lead(parse_cycle("20261029T06Z")), 144)
        self.assertEqual(MODELS["ifs"].max_lead(parse_cycle("20261029T00Z")), 360)


class FrameTests(unittest.TestCase):
    def test_multiple_messages(self):
        self.assertEqual(validate_grib(grib_frame() + grib_frame(b"other")), 2)

    def test_corrupt_and_truncated_rejected(self):
        for data in [b"", b"<html>error</html>", grib_frame()[:-1], grib_frame() + b"garbage"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_grib(data)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        config_path = Path(self.temp.name) / "config.json"
        config_path.write_text(json.dumps({"models": ["gfs"], "fields": ["t2m"], "leads": [24]}))
        self.config = load_config(config_path)
        self.cycle = parse_cycle("20261029T00Z")

    def test_mirror_fallback_and_idempotent_cache(self):
        frame = grib_frame()
        class FakeHTTP:
            calls = []
            def get(self, url, start=None, end=None):
                self.calls.append((url, start))
                if url.endswith("idx"):
                    return f"1:0:d=x:TMP:2 m above ground:x\n2:{len(frame)}:d=x:HGT:500 mb:x".encode()
                if "s3.amazonaws.com" in url:
                    raise TimeoutError("simulated source interruption")
                return frame
        http = FakeHTTP()
        pipeline = Pipeline(self.config, self.temp.name, http)
        pipeline.plan("gfs", self.cycle)
        job = pipeline.catalog.jobs()[0]
        self.assertEqual(pipeline.download(job), "downloaded")
        saved = pipeline.catalog.jobs()[0]
        self.assertIn("nomads", saved["source"])
        calls = len(http.calls)
        self.assertEqual(pipeline.download(saved), "cached")
        self.assertEqual(len(http.calls), calls)
        # A file altered without changing its size must be downloaded again.
        target = pipeline.root / saved["path"]
        target.write_bytes(b"x" * len(frame))
        self.assertEqual(pipeline.download(saved), "downloaded")

    def test_missing_field_stays_pending_without_publishing(self):
        class FakeHTTP:
            def get(self, *args):
                return b"1:0:d=x:TMP:850 mb:x"
        pipeline = Pipeline(self.config, self.temp.name, FakeHTTP())
        pipeline.plan("gfs", self.cycle)
        self.assertEqual(pipeline.download(pipeline.catalog.jobs()[0]), "pending")
        data = pipeline.catalog.export(self.config)
        self.assertIsNone(data["models"][0]["latest_complete"])
        self.assertEqual(data["models"][0]["runs"][0]["status"], "partial")

    def test_writer_lock_prevents_overlap(self):
        with writer_lock(self.temp.name):
            with self.assertRaises(RuntimeError):
                with writer_lock(self.temp.name):
                    pass

    def test_selection_changes_namespace(self):
        p = Path(self.temp.name) / "config.json"
        c = json.loads(p.read_text())
        c["fields"] = ["mslp"]
        p.write_text(json.dumps(c))
        self.assertNotEqual(load_config(p)["selection_id"], self.config["selection_id"])

    def test_discovery_continues_after_unavailable_mirror(self):
        pipeline = Pipeline(self.config, self.temp.name)
        older = parse_cycle("20261029T00Z")
        newer = parse_cycle("20261029T06Z")
        with patch("nwp_ingest.pipeline.cycles", return_value=[newer, older]), patch.object(pipeline, "locate", side_effect=[RuntimeError("primary 404; secondary 403"), ("url", "index", {})]):
            self.assertEqual(pipeline.discover("gfs"), older)

    def test_retention_preserves_latest_complete_fallback(self):
        catalog = Catalog(Path(self.temp.name) / "dataset")
        for hour in (0, 6, 12, 18):
            cycle = f"20261029T{hour:02d}Z"
            catalog.plan("gfs", cycle, [24], [0])
            path = catalog.root / "raw" / "gfs" / cycle
            path.mkdir(parents=True)
        catalog.update(catalog.jobs("gfs", "20261029T00Z")[0], status="complete")
        catalog.prune(2)
        self.assertEqual({j["cycle"] for j in catalog.jobs()}, {"20261029T00Z", "20261029T12Z", "20261029T18Z"})
        self.assertFalse((catalog.root / "raw/gfs/20261029T06Z").exists())

    def test_complete_download_without_compilation_not_ready(self):
        pipeline = Pipeline(self.config, self.temp.name)
        pipeline.plan("gfs", self.cycle)
        pipeline.catalog.update(pipeline.catalog.jobs()[0], status="complete")
        model = pipeline.catalog.export(self.config)["models"][0]
        self.assertEqual(model["latest_downloaded"], "20261029T00Z")
        self.assertIsNone(model["latest_complete"])
        self.assertEqual(model["runs"][0]["status"], "partial")


class APITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import threading
        import numpy as np
        from functools import partial
        from http.server import ThreadingHTTPServer
        from nwp_ingest.server import Handler
        from nwp_ingest.catalog import atomic_json
        from nwp_ingest.processing import atomic_npz
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        config_path = Path(cls.temp.name) / "config.json"
        config_path.write_text(json.dumps({"models": ["gfs", "gefs"], "fields": ["t2m"], "leads": [24], "members": {"gefs": [0, 1]}}))
        cls.pipeline = Pipeline(load_config(config_path), cls.temp.name)
        path = cls.pipeline.root / "compiled/gfs/20261029T00Z/f024.npz"
        atomic_npz(path, {"latitude": np.array([-90, 0, 90]), "longitude": np.array([-180, -90, 0, 90]), "t2m": np.array([[1.,2,3,4], [5,6,np.nan,8], [9,10,11,12]])})
        atomic_json(path.with_suffix(".json"), {"model": "gfs", "cycle": "20261029T00Z", "lead": 24})
        member_path = cls.pipeline.root / "normalized/gefs/20261029T00Z/f024/m01.npz"
        atomic_npz(member_path, {"latitude": np.array([-90, 0, 90]), "longitude": np.array([-180, -90, 0, 90]), "t2m": np.full((3, 4), 283.5)})
        atomic_json(member_path.with_suffix(".json"), {"model": "gefs", "member": 1})
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, pipeline=cls.pipeline))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def get(self, path):
        from urllib.request import urlopen
        with urlopen(self.base + path) as response:
            return json.loads(response.read())

    def test_nan_is_null_and_coordinates_exposed(self):
        result = self.get("/api/field?model=gfs&cycle=20261029T00Z&lead=24&field=t2m")
        self.assertIsNone(result["values"][1][2])
        self.assertEqual(result["latitude"], [-90,0,90])

    def test_nearest_point_wraps_dateline(self):
        result = self.get("/api/point?model=gfs&cycle=20261029T00Z&lead=24&lat=0&lon=179.99")
        self.assertEqual(result["longitude"], -180)
        self.assertEqual(result["value"], 5)

    def test_path_traversal_and_unknown_model_rejected(self):
        from urllib.error import HTTPError
        with self.assertRaises(HTTPError) as error:
            self.get("/api/point?model=../gfs&cycle=20261029T00Z&lead=24&lat=0&lon=0")
        self.assertEqual(error.exception.code, 400)

    def test_member_request_reads_the_selected_normalized_grid(self):
        query = "model=gefs&cycle=20261029T00Z&lead=24&field=t2m&member=1"
        grid = self.get("/api/field?" + query)
        point = self.get("/api/point?" + query + "&lat=0&lon=0")
        self.assertEqual(grid["statistic"], "member")
        self.assertEqual(grid["metadata"]["member"], 1)
        self.assertEqual(point["value"], grid["values"][1][2])
        self.assertEqual(point["value"], 283.5)


class StatisticsTests(unittest.TestCase):
    def test_spread_quantiles_and_missing_member_count(self):
        import numpy as np
        from nwp_ingest.processing import statistics
        stack = np.array([[[1, 4], [2, 9]], [[3, 8], [6, np.nan]]], dtype="float32")
        actual = statistics(stack, tile_rows=1)
        self.assertAlmostEqual(actual["mean"][0, 0], 2)
        self.assertAlmostEqual(actual["spread"][0, 0], 1)
        self.assertAlmostEqual(actual["p10"][0, 0], 1.2, places=5)
        self.assertAlmostEqual(actual["p90"][0, 0], 2.8, places=5)
        self.assertEqual(actual["member_count"][1, 1], 1)
        self.assertTrue(np.isnan(actual["mean"][1, 1]))


if __name__ == "__main__":
    unittest.main()
