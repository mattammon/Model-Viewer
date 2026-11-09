import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from nwp_ingest.catalog import atomic_json, sha256
from nwp_ingest.models import load_config, parse_cycle
from nwp_ingest.pipeline import Pipeline
from nwp_ingest.processing import atomic_npz, direction_statistics

CONFIG = Path(__file__).resolve().parents[1] / "config"
KEY = ("aifs_ens", "20261108T12Z", 0)


class MemberWindArchiveTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        config_path = Path(temp.name) / "test.json"
        config = json.loads((CONFIG / "smoke.json").read_text())
        config.update(models=["aifs_ens"], leads=[0, 6], members={"aifs_ens": [0, 1]}, cycle_hours={},
                      retain_cycles=1)
        config_path.write_text(json.dumps(config))
        self.pipeline = Pipeline(load_config(config_path), temp.name)
        self.downloaded = []

    def staged_dir(self, job):
        return self.pipeline.root / "normalized" / job["model"] / job["cycle"] / f"f{job['lead']:03d}"

    def stage_member(self, job):
        if self.pipeline.catalog.valid(job):
            return "cached"
        self.downloaded.append((job["cycle"], job["lead"], job["member"]))
        path = self.staged_dir(job) / f"m{job['member']:02d}.npz"
        speed = np.arange(36, dtype="float32").reshape(6, 6) + job["member"] * 2
        atomic_npz(path, {"latitude": [20, 48, 50, 55, 60, 80], "longitude": [-40, 5, 10, 15, 20, 60],
                          "ws10": speed, "ws100": speed + 20, "z500": speed + 5500,
                          "wd10": np.full_like(speed, 350 if job["member"] == 0 else 10)})
        atomic_json(path.with_suffix(".json"), {})
        self.pipeline.catalog.update(job, status="complete", path=str(path.relative_to(self.pipeline.root)),
                                     size=path.stat().st_size, sha256=sha256(path))
        return "downloaded"

    def sync(self, cycle=KEY[1]):
        return self.pipeline.sync(parse_cycle(cycle))

    def test_publish_cleanup_cache_and_archive_retention(self):
        def stage(job):
            if job["lead"] == 6:
                self.assertFalse((self.staged_dir(job).parent / "f000").exists())
            return self.stage_member(job)

        with patch.object(self.pipeline, "download", side_effect=stage):
            catalog, counts, errors = self.sync()
            self.assertFalse(errors)
            self.assertEqual(counts["downloaded"], 4)
            self.assertEqual(catalog["models"][0]["runs"][0]["compiled_leads"], [0, 6])
            self.assertEqual(self.sync()[1]["cached"], 4)
            self.assertEqual(len(self.downloaded), 4)
            root = self.pipeline.root
            archive = root / "member_winds/aifs_ens/20261108T12Z/f000.npz"
            with np.load(archive) as data:
                self.assertEqual(data["ws10"].shape, (2, 3, 3))
                self.assertEqual(set(data.files) - {"latitude", "longitude", "member", "model", "cycle", "lead_hours", "valid_time"},
                                 {"ws10", "ws100"})
                np.testing.assert_array_equal(data["member"], [0, 1])
                np.testing.assert_array_equal(data["latitude"], [48, 50, 55])
                np.testing.assert_array_equal(data["longitude"], [5, 10, 15])
                np.testing.assert_array_equal(data["ws100"] - data["ws10"], 20)
                self.assertEqual(data["valid_time"].item(), "2026-11-08T12:00:00+00:00")
            summary = root / "compiled/aifs_ens/20261108T12Z/f000.npz"
            with np.load(summary) as data:
                self.assertEqual(data["ws10__mean"].shape, (6, 6))
                self.assertNotIn("ws10__member_count", data.files)
                self.assertAlmostEqual(data["ws10__mean"][1, 1], 8)
                self.assertAlmostEqual(data["ws10__spread"][1, 1], 1)
                self.assertAlmostEqual(data["ws10__p90"][1, 1], 8.8, places=5)
                self.assertAlmostEqual(data["wd10__p10"][1, 1], 352, places=4)
            self.assertEqual(list((root / "normalized").rglob("*.npz")), [])
            # A missing archive is repaired even if the previous member staging was deleted.
            archive.unlink()
            self.assertEqual(self.sync()[1]["downloaded"], 2)
            self.assertTrue(archive.is_file())
            self.sync("20261108T18Z")
            self.assertFalse(summary.exists())
            self.assertTrue(archive.is_file())

    def test_failure_before_publication_preserves_staging_for_retry(self):
        def fail_archive(path, arrays):
            if path.parts[-4] == "member_winds":
                raise OSError("simulated write failure")
            return atomic_npz(path, arrays)

        with patch.object(self.pipeline, "download", side_effect=self.stage_member):
            with patch("nwp_ingest.processing.atomic_npz", side_effect=fail_archive):
                with self.assertLogs("nwp_ingest.pipeline", level="ERROR"):
                    catalog, _, errors = self.sync()
            self.assertEqual(len(errors), 2)
            self.assertEqual(catalog["models"][0]["runs"][0]["compiled_leads"], [])
            self.assertEqual(len(list((self.pipeline.root / "normalized").rglob("*.npz"))), 4)
            catalog, counts, errors = self.sync()
            self.assertFalse(errors)
            self.assertEqual(counts["cached"], 4)
            self.assertEqual(catalog["models"][0]["runs"][0]["compiled_leads"], [0, 6])
            self.assertEqual(list((self.pipeline.root / "normalized").rglob("*.npz")), [])

    def test_starter_has_day_ten_and_long_ifs_cycles(self):
        config = load_config(CONFIG / "starter.json")
        self.assertEqual(config["leads"], list(range(0, 241, 6)))
        self.assertEqual(config["member_wind_bounds"], [5, 15, 48, 55])
        pipe = Pipeline(config, self.pipeline.root)
        newer, older = parse_cycle("20261108T18Z"), parse_cycle(KEY[1])
        with patch("nwp_ingest.pipeline.cycles", return_value=[newer, older]), patch.object(pipe, "locate"):
            self.assertEqual(pipe.discover("ifs_ens"), older)
            self.assertEqual(pipe.discover("aifs_ens"), newer)

    def test_direction_spread_and_quantiles_cross_north(self):
        stats = direction_statistics(np.array([[[350.]], [[10.]]], dtype="float32"))
        self.assertAlmostEqual(float(stats["p10"].item()), 352, places=4)
        self.assertAlmostEqual(float(stats["p90"].item()), 8, places=4)
        self.assertAlmostEqual(float(stats["spread"].item()), 10.0256, places=3)
