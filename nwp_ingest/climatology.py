"""Daily 500 hPa height normals for Europe from NOAA PSL."""
from datetime import date
from functools import lru_cache
from pathlib import Path

SOURCE = "NOAA PSL NCEP/NCAR Reanalysis 1 daily 1991–2020 climatology"
REFERENCE_BOUNDS = (-40, 60, 20, 80)


@lru_cache(maxsize=1)
def _normals():
    import numpy as np

    with np.load(Path(__file__).with_name("z500_climatology.npz")) as data:
        return data["lat"], data["lon"], data["height_dm"].astype("float32") * 0.1 + 5500


def daily_z500(valid_date, latitude, longitude):
    import numpy as np

    lat, lon, normals = _normals()
    if valid_date.month == 2 and valid_date.day == 29:
        normal = (normals[58] + normals[59]) / 2
    else:
        day = (valid_date.replace(year=2001) - date(2001, 1, 1)).days
        normal = normals[day]
    zonal = np.stack([np.interp(longitude, lon, row) for row in normal], axis=0)
    return np.stack([np.interp(latitude, lat, column) for column in zonal.T], axis=1).astype("float32")
