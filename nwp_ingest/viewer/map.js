const DOMAINS = {
  global: [-180, 180, -90, 90],
  "north-america": [-169, -48, 13, 74],
  conus: [-128, -65, 22, 52],
  europe: [-26, 44, 30, 72],
  asia: [38, 179, 4, 77],
  australia: [108, 158, -47, -8],
};

const CITIES = [
  [-122.3, 47.6, "Seattle"], [-118.2, 34.1, "Los Angeles"], [-104.9, 39.7, "Denver"],
  [-97.4, 35.2, "Norman"], [-87.6, 41.9, "Chicago"], [-74.0, 40.7, "New York"],
  [-80.2, 25.8, "Miami"], [-0.1, 51.5, "London"], [2.4, 48.9, "Paris"],
  [13.4, 52.5, "Berlin"], [-3.7, 40.4, "Madrid"], [12.5, 41.9, "Rome"],
  [21.0, 52.2, "Warsaw"], [18.1, 59.3, "Stockholm"], [23.7, 38.0, "Athens"],
  [139.7, 35.7, "Tokyo"], [116.4, 39.9, "Beijing"], [77.2, 28.6, "Delhi"],
  [151.2, -33.9, "Sydney"], [115.9, -32.0, "Perth"], [145.0, -37.8, "Melbourne"],
];

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function rgb(hex) {
  return [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
}

function lookupTable(colors) {
  const stops = colors.map(rgb);
  return Array.from({length: 256}, (_, i) => {
    const position = i * (stops.length - 1) / 255;
    const left = Math.min(Math.floor(position), stops.length - 2);
    const mix = position - left;
    return stops[left].map((value, j) => Math.round(value + mix * (stops[left + 1][j] - value)));
  });
}

export class ForecastMap {
  constructor(canvas, onPoint, onView) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onPoint = onPoint;
    this.onView = onView;
    this.bounds = [...DOMAINS.global];
    this.layers = {};
    this.point = null;
    this.raster = null;
    this.drag = null;
    this.frame = 0;
    this.resize = new ResizeObserver(() => this.draw());
    this.resize.observe(canvas);
    this.bind();
  }

  setBoundaries(layers) {
    this.layers = layers;
    this.schedule();
  }

  setDomain(domain) {
    this.bounds = [...DOMAINS[domain]];
    this.schedule();
  }

  setPoint(point) {
    this.point = point;
    this.schedule();
  }

  setField(grid, scale) {
    this.raster = null;
    if (grid) {
      const {latitude, longitude, values} = grid;
      const image = document.createElement("canvas");
      image.width = longitude.length;
      image.height = latitude.length;
      const context = image.getContext("2d");
      const pixels = context.createImageData(image.width, image.height);
      const colors = lookupTable(scale.colors);
      for (let y = 0; y < image.height; y++) {
        const row = values[image.height - y - 1];
        for (let x = 0; x < image.width; x++) {
          if (row[x] === null) continue;
          const fraction = (scale.convert(row[x]) - scale.min) / (scale.max - scale.min);
          const color = colors[clamp(Math.round(fraction * 255), 0, 255)];
          const i = (y * image.width + x) * 4;
          pixels.data.set(color, i);
          pixels.data[i + 3] = 255;
        }
      }
      context.putImageData(pixels, 0, 0);
      const dx = longitude[1] - longitude[0];
      const dy = latitude[1] - latitude[0];
      this.raster = {
        image,
        west: longitude[0] - dx / 2,
        east: longitude.at(-1) + dx / 2,
        south: latitude[0] - dy / 2,
        north: latitude.at(-1) + dy / 2,
      };
    }
    this.schedule();
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  project(lon, lat) {
    const [west, east, south, north] = this.bounds;
    return [(lon - west) * this.width / (east - west), (north - lat) * this.height / (north - south)];
  }

  location(x, y) {
    const [west, east, south, north] = this.bounds;
    return {lon: west + x * (east - west), lat: north - y * (north - south)};
  }

  view(center, width, height, x = .5, y = .5) {
    const west = clamp(center.lon - width * x, -180, 180 - width);
    const south = clamp(center.lat - height * (1 - y), -90, 90 - height);
    this.bounds = [west, west + width, south, south + height];
    this.onView();
    this.schedule();
  }

  zoom(factor, x = .5, y = .5) {
    const [west, east, south, north] = this.bounds;
    const width = east - west;
    const height = north - south;
    const ratio = clamp(factor, Math.max(6 / width, 3 / height), Math.min(360 / width, 180 / height));
    this.view(this.location(x, y), width * ratio, height * ratio, x, y);
  }

  pan(dx, dy, origin = this.bounds) {
    const [west, east, south, north] = origin;
    const width = east - west;
    const height = north - south;
    this.view({lon: (west + east) / 2 + dx * width, lat: (north + south) / 2 + dy * height}, width, height);
  }

  bind() {
    const canvas = this.canvas;
    const position = event => {
      const rect = canvas.getBoundingClientRect();
      return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
    };
    canvas.addEventListener("wheel", event => {
      event.preventDefault();
      this.zoom(Math.exp(clamp(event.deltaY, -150, 150) * .003), ...position(event));
    }, {passive: false});
    canvas.addEventListener("pointerdown", event => {
      if (event.button !== 0 || this.drag) return;
      canvas.setPointerCapture(event.pointerId);
      this.drag = {id: event.pointerId, start: position(event), bounds: [...this.bounds], moved: false};
    });
    canvas.addEventListener("pointermove", event => {
      if (this.drag?.id !== event.pointerId) return;
      const [x, y] = position(event);
      const dx = this.drag.start[0] - x;
      const dy = y - this.drag.start[1];
      if (Math.hypot(dx * this.width, dy * this.height) > 4) this.drag.moved = true;
      if (this.drag.moved) {
        canvas.classList.add("dragging");
        this.pan(dx, dy, this.drag.bounds);
      }
    });
    const end = event => {
      if (this.drag?.id !== event.pointerId) return;
      if (event.type === "pointerup" && !this.drag.moved) this.onPoint(this.location(...position(event)));
      this.drag = null;
      canvas.classList.remove("dragging");
    };
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(event, end);
    canvas.addEventListener("keydown", event => {
      const direction = {ArrowLeft: [-.12, 0], ArrowRight: [.12, 0], ArrowUp: [0, .12], ArrowDown: [0, -.12]}[event.key];
      if (direction) this.pan(...direction);
      else if (event.key === "Enter") this.onPoint(this.location(.5, .5));
      else if (event.key === "+" || event.key === "=") this.zoom(.75);
      else if (event.key === "-") this.zoom(1.33);
      else return;
      event.preventDefault();
    });
  }

  drawLines(lines, color, width) {
    if (!lines?.length) return;
    const c = this.context;
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    for (const line of lines) {
      let previous = null;
      for (const [lon, lat] of line) {
        const [x, y] = this.project(lon, lat);
        if (previous === null || Math.abs(lon - previous) > 180) c.moveTo(x, y);
        else c.lineTo(x, y);
        previous = lon;
      }
    }
    c.stroke();
  }

  drawGrid() {
    const c = this.context;
    const [west, east, south, north] = this.bounds;
    const step = [1, 2, 5, 10, 15, 30, 60, 90].find(n => n >= (east - west) / 13) || 90;
    const lines = [];
    c.font = "10px ui-monospace, monospace";
    c.textAlign = "center";
    const label = (x, y, text) => {
      c.lineWidth = 3;
      c.strokeStyle = "#0a1626";
      c.strokeText(text, x, y);
      c.fillStyle = "#e3ebf4";
      c.fillText(text, x, y);
    };
    for (let lon = Math.ceil(west / step) * step; lon < east; lon += step) {
      lines.push([[lon, south], [lon, north]]);
      const [x] = this.project(lon, north);
      if (x > 29 && x < this.width - 29) label(x, this.height - 12, Math.abs(lon) + "°" + (lon < 0 ? "W" : lon > 0 ? "E" : ""));
    }
    for (let lat = Math.ceil(south / step) * step; lat < north; lat += step) {
      lines.push([[west, lat], [(west + east) / 2, lat], [east, lat]]);
      const [, y] = this.project(west, lat);
      if (y > 47 && y < this.height - 31) label(23, y - 4, Math.abs(lat) + "°" + (lat < 0 ? "S" : lat > 0 ? "N" : ""));
    }
    this.drawLines(lines, "#c0d9ff36", .75);
  }

  draw() {
    const c = this.context;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#132238";
    c.fillRect(0, 0, this.width, this.height);
    if (this.raster) {
      const {image, west, east, south, north} = this.raster;
      c.imageSmoothingEnabled = false;
      for (const offset of [-360, 0, 360]) {
        const [left, top] = this.project(west + offset, north);
        const [right, bottom] = this.project(east + offset, south);
        if (right > 0 && left < this.width) c.drawImage(image, left, top, right - left, bottom - top);
      }
      c.fillStyle = "#070f1d19";
      c.fillRect(0, 0, this.width, this.height);
    }
    this.drawGrid();
    const span = this.bounds[1] - this.bounds[0];
    this.drawLines(this.layers.states, span < 150 ? "#162737b0" : "#16273750", .7);
    this.drawLines(this.layers.borders, "#111f30c9", .85);
    this.drawLines(this.layers.coast, this.raster ? "#101b2e" : "#7793b3", 1.15);
    if (span < 115) {
      c.textAlign = "left";
      c.font = "10px system-ui, sans-serif";
      const labels = [];
      for (const [lon, lat, name] of CITIES) {
        const [x, y] = this.project(lon, lat);
        if (x < 6 || x > this.width - 54 || y < 32 || y > this.height - 22) continue;
        if (labels.some(([lx, ly]) => Math.abs(lx - x) < 75 && Math.abs(ly - y) < 13)) continue;
        labels.push([x, y]);
        c.fillStyle = "#edf4fc";
        c.beginPath();
        c.arc(x, y, 2, 0, Math.PI * 2);
        c.fill();
        c.strokeStyle = "#0b1728";
        c.lineWidth = 3;
        c.strokeText(name, x + 5, y - 2);
        c.fillText(name, x + 5, y - 2);
      }
    }
    if (this.point) {
      const [x, y] = this.project(this.point.lon, this.point.lat);
      c.beginPath();
      c.arc(x, y, 7, 0, Math.PI * 2);
      c.lineWidth = 4;
      c.strokeStyle = "#07101d";
      c.stroke();
      c.lineWidth = 2;
      c.strokeStyle = "#fff";
      c.stroke();
    }
  }
}
