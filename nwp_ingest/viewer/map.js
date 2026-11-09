const DOMAINS = {
  global: [-180, 180, -90, 90],
  "north-america": [-169, -48, 13, 74],
  conus: [-128, -65, 22, 52],
  europe: [-40, 60, 20, 80],
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

export const HEIGHT_CONTOUR_INTERVAL = 60;

export function heightContours({latitude, longitude, values}, interval = HEIGHT_CONTOUR_INTERVAL) {
  const contours = new Map();
  for (let row = 0; row < latitude.length - 1; row++) {
    for (let col = 0; col < longitude.length - 1; col++) {
      const heights = [values[row][col], values[row][col + 1], values[row + 1][col + 1], values[row + 1][col]];
      if (heights.some(value => !Number.isFinite(value))) continue;
      const first = Math.ceil(Math.min(...heights) / interval) * interval;
      const last = Math.max(...heights);
      if (first >= last) continue;
      const west = longitude[col], east = longitude[col + 1];
      const south = latitude[row], north = latitude[row + 1];
      const corners = [[west, south], [east, south], [east, north], [west, north]];
      for (let level = first; level < last; level += interval) {
        const above = heights.map(value => value > level);
        const crossings = [];
        for (let i = 0; i < 4; i++) {
          const next = (i + 1) % 4;
          if (above[i] === above[next]) continue;
          const fraction = (level - heights[i]) / (heights[next] - heights[i]);
          crossings.push(corners[i].map((value, axis) => value + fraction * (corners[next][axis] - value)));
        }
        if (!contours.has(level)) contours.set(level, []);
        const segments = contours.get(level);
        if (crossings.length === 2) {
          segments.push(crossings);
        } else if (crossings.length === 4) {
          // Use the bilinear saddle decision to connect ambiguous crossings.
          const [a, b, c, d] = heights.map(value => value - level);
          const [p, q, r, t] = crossings;
          if (a * c >= b * d) segments.push([p, q], [r, t]);
          else segments.push([p, t], [q, r]);
        }
      }
    }
  }
  return contours;
}

export function windBarbParts(speed) {
  const knots = Math.round(speed * 1.94384449 / 5) * 5;
  return {pennants: Math.floor(knots / 50), full: Math.floor(knots % 50 / 10), half: knots % 10 === 5};
}

function drawWindBarb(context, x, y, speed, direction, size) {
  if (!Number.isFinite(speed) || speed < 0) return;
  const {pennants, full, half} = windBarbParts(speed);
  const calm = !pennants && !full && !half;
  if (!calm && !Number.isFinite(direction)) return;
  const lines = new Path2D();
  const flags = new Path2D();
  context.save();
  context.translate(x, y);
  if (calm) {
    lines.arc(0, 0, size * .13, 0, Math.PI * 2);
  } else {
    context.rotate((direction - 90) * Math.PI / 180);
    lines.moveTo(0, 0);
    lines.lineTo(size, 0);
    const step = size * Math.min(.14, .78 / (2 * pennants + full + Number(half)));
    let position = size;
    for (let i = 0; i < pennants; i++) {
      flags.moveTo(position, 0);
      flags.lineTo(position - 2 * step, 0);
      flags.lineTo(position, size * .40);
      flags.closePath();
      position -= 2 * step;
    }
    for (let i = 0; i < full; i++) {
      lines.moveTo(position, 0);
      lines.lineTo(position + size * .21, size * .40);
      position -= step;
    }
    if (half) {
      if (!pennants && !full) position -= step;
      lines.moveTo(position, 0);
      lines.lineTo(position + size * .105, size * .20);
    }
  }
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#ffffffe0";
  context.lineWidth = 2.8;
  context.stroke(lines);
  if (pennants) context.stroke(flags);
  context.strokeStyle = "#0a1422";
  context.fillStyle = "#0a1422";
  context.lineWidth = 1.2;
  context.stroke(lines);
  if (pennants) context.fill(flags);
  context.restore();
}

export class ForecastMap {
  constructor(canvas, onPoint, onView) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.onPoint = onPoint;
    this.onView = onView;
    this.bounds = [...DOMAINS.europe];
    this.limits = DOMAINS.global;
    this.layers = {};
    this.point = null;
    this.raster = null;
    this.wind = null;
    this.contours = null;
    this.barbSize = 22;
    this.barbSpacing = 52;
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

  setDomain(domain, limits) {
    this.limits = limits || DOMAINS.global;
    this.bounds = [...(limits || DOMAINS[domain])];
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

  setWindOverlay(wind) {
    this.wind = wind;
    this.schedule();
  }

  setHeightOverlay(grid) {
    this.contours = grid ? heightContours(grid) : null;
    this.schedule();
  }

  setBarbStyle(size, spacing) {
    this.barbSize = size;
    this.barbSpacing = spacing;
    this.schedule();
  }

  drawWindOverlay() {
    if (!this.wind) return;
    const {speed, direction} = this.wind;
    const {latitude, longitude, values} = speed;
    if (latitude.length < 2 || longitude.length < 2) return;
    const [west, east, south, north] = this.bounds;
    const dy = latitude[1] - latitude[0], dx = longitude[1] - longitude[0];
    const rowStep = Math.max(1, Math.ceil(this.barbSpacing * (north - south) / (dy * this.height)));
    const colStep = Math.max(1, Math.ceil(this.barbSpacing * (east - west) / (dx * this.width)));
    const firstRow = Math.max(0, Math.ceil((south - latitude[0]) / (dy * rowStep)) * rowStep);
    const firstCol = Math.max(0, Math.ceil((west - longitude[0]) / (dx * colStep)) * colStep);
    for (let row = firstRow; row < latitude.length && latitude[row] <= north; row += rowStep) {
      for (let col = firstCol; col < longitude.length && longitude[col] <= east; col += colStep) {
        const [x, y] = this.project(longitude[col], latitude[row]);
        drawWindBarb(this.context, x, y, values[row][col], direction.values[row][col], this.barbSize);
      }
    }
  }

  drawHeightOverlay() {
    if (!this.contours) return;
    const context = this.context;
    const [west, east, south, north] = this.bounds;
    const labels = [];
    context.strokeStyle = "#000";
    context.lineWidth = 1.25;
    context.lineCap = "round";
    context.beginPath();
    for (const [level, segments] of this.contours) {
      for (const [[lon1, lat1], [lon2, lat2]] of segments) {
        if (Math.max(lon1, lon2) < west || Math.min(lon1, lon2) > east ||
            Math.max(lat1, lat2) < south || Math.min(lat1, lat2) > north) continue;
        const [x1, y1] = this.project(lon1, lat1);
        const [x2, y2] = this.project(lon2, lat2);
        context.moveTo(x1, y1);
        context.lineTo(x2, y2);
        const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
        if (x < 30 || x > this.width - 35 || y < 40 || y > this.height - 28) continue;
        if (labels.some(label => Math.abs(label.x - x) < (label.level === level ? 150 : 44) &&
            Math.abs(label.y - y) < (label.level === level ? 105 : 25))) continue;
        labels.push({x, y, level});
      }
    }
    context.stroke();
    context.font = "bold 10px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#000";
    context.strokeStyle = "#ffffffe8";
    context.lineWidth = 3;
    for (const {x, y, level} of labels) {
      context.strokeText(String(level), x, y);
      context.fillText(String(level), x, y);
    }
    context.textBaseline = "alphabetic";
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
    const [left, right, bottom, top] = this.limits;
    const west = clamp(center.lon - width * x, left, right - width);
    const south = clamp(center.lat - height * (1 - y), bottom, top - height);
    this.bounds = [west, west + width, south, south + height];
    this.onView();
    this.schedule();
  }

  zoom(factor, x = .5, y = .5) {
    const [west, east, south, north] = this.bounds;
    const width = east - west;
    const height = north - south;
    const [left, right, bottom, top] = this.limits;
    const maximum = Math.min((right - left) / width, (top - bottom) / height);
    const ratio = clamp(factor, Math.min(maximum, Math.max(6 / width, 3 / height)), maximum);
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
    this.drawHeightOverlay();
    this.drawWindOverlay();
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
