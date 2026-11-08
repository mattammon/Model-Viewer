"""Bounded HTTP requests; range responses must match exactly."""
import random
import re
import socket
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class Missing(Exception):
    pass


class HTTP:
    def __init__(self, timeout=40, retries=3):
        self.timeout, self.retries = timeout, retries

    def get(self, url, start=None, end=None):
        headers = {"User-Agent": "ModelViewer/0.1 (public forecast subset downloader)"}
        if start is not None:
            headers["Range"] = f"bytes={start}-{'' if end is None else end}"
        for attempt in range(self.retries + 1):
            try:
                with urlopen(Request(url, headers=headers), timeout=self.timeout) as response:
                    if start is not None:
                        if response.status != 206:
                            raise ValueError(f"Server ignored Range request: {url}")
                        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", response.headers.get("Content-Range", ""))
                        if not match or int(match[1]) != start or (end is not None and int(match[2]) != end):
                            raise ValueError(f"Unexpected Content-Range: {response.headers.get('Content-Range')}")
                        expected = int(match[2]) - start + 1
                        if expected > 64 * 1024 * 1024:
                            raise ValueError("Single range exceeds 64 MiB limit")
                    else:
                        expected = None
                    limit = expected if expected is not None else 64 * 1024 * 1024
                    data = response.read(limit + 1)
                    if len(data) > limit or (expected is not None and len(data) != expected):
                        raise ValueError("Truncated or oversized HTTP response")
                    return data
            except HTTPError as exc:
                if exc.code in (404, 410):
                    raise Missing(url) from exc
                if exc.code not in (408, 429, 500, 502, 503, 504) or attempt == self.retries:
                    raise
                delay = min(30, float(exc.headers.get("Retry-After", 2 ** attempt))) if str(exc.headers.get("Retry-After", "")).isdigit() else 2 ** attempt
            except (URLError, TimeoutError, socket.timeout, ConnectionError):
                if attempt == self.retries:
                    raise
                delay = 2 ** attempt
            time.sleep(delay + random.random())


def validate_grib(data):
    """Check every GRIB2 frame, not just a leading magic string."""
    cursor, count = 0, 0
    while cursor < len(data):
        if data[cursor:cursor + 4] != b"GRIB" or len(data) - cursor < 20 or data[cursor + 7] != 2:
            raise ValueError("Invalid GRIB2 header")
        length = int.from_bytes(data[cursor + 8:cursor + 16], "big")
        if length < 20 or cursor + length > len(data) or data[cursor + length - 4:cursor + length] != b"7777":
            raise ValueError("Incomplete GRIB2 message")
        cursor += length
        count += 1
    if not count:
        raise ValueError("Empty GRIB response")
    return count
