from datetime import date
from pathlib import Path
import unittest

import numpy as np

from nwp_ingest.climatology import daily_z500
from nwp_ingest.models import load_config, product_fields
from nwp_ingest.processing import circular_mean


class RegionalProductsTests(unittest.TestCase):
    def test_shipped_profiles_expose_only_requested_products(self):
        root = Path(__file__).resolve().parents[1]
        fields = {"z500", "z500_anom", "t2m", "ws850", "wd850", "ws10", "wd10", "ws100", "wd100"}
        for name in ("starter", "smoke", "operational"):
            with self.subTest(profile=name):
                config = load_config(root / "config" / (name + ".json"))
                self.assertEqual(config["models"], ["ifs_ens", "aifs_ens"])
                self.assertEqual(config["bounds"], [-40, 60, 20, 80])
                self.assertEqual(product_fields(config).keys(), fields)

    def test_circular_mean_wrap_and_undefined_directions(self):
        directions = np.array([[[350, 0, np.nan, np.nan]], [[10, 180, np.nan, 270]]], dtype="float32")
        result = circular_mean(directions)[0]
        self.assertAlmostEqual((float(result[0]) + 180) % 360 - 180, 0, places=4)
        self.assertTrue(np.isnan(result[1:3]).all())
        self.assertAlmostEqual(result[3], 270, places=4)

    def test_daily_normals_vary_and_interpolate_leap_day(self):
        latitude, longitude = [20, 51.25, 80], [-40, 13.25, 60]
        before = daily_z500(date(2028, 2, 28), latitude, longitude)
        after = daily_z500(date(2028, 3, 1), latitude, longitude)
        leap = daily_z500(date(2028, 2, 29), latitude, longitude)
        summer = daily_z500(date(2028, 7, 1), latitude, longitude)
        self.assertEqual(leap.shape, (3, 3))
        np.testing.assert_allclose(leap, (before + after) / 2, atol=0.001)
        self.assertGreater(np.max(np.abs(leap - summer)), 100)


if __name__ == "__main__":
    unittest.main()
