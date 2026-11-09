const HOUR = 3600000;

export function cycleDate(cycle) {
  return new Date(cycle.slice(0, 4) + "-" + cycle.slice(4, 6) + "-" + cycle.slice(6, 8) + "T" + cycle.slice(9, 11) + ":00:00Z");
}

const utcDate = new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
export function formatTime(date) {
  return utcDate.format(date).replace(",", " ·") + " UTC";
}

export function validTime(cycle, lead) {
  return cycle && lead !== null ? +cycleDate(cycle) + lead * HOUR : null;
}

export function framesAt(runs, valid) {
  if (valid === null) return [];
  const matches = [];
  for (const run of runs) {
    const lead = (valid - cycleDate(run.cycle)) / HOUR;
    if (run.compiled_leads.includes(lead)) matches.push({cycle: run.cycle, lead});
  }
  return matches.sort((a, b) => a.cycle.localeCompare(b.cycle));
}

export function availableValidTimes(runs) {
  const counts = new Map();
  for (const run of runs) {
    for (const lead of run.compiled_leads) {
      const valid = validTime(run.cycle, lead);
      counts.set(valid, (counts.get(valid) || 0) + 1);
    }
  }
  return [...counts].sort(([a], [b]) => a - b);
}

const SVG = "http://www.w3.org/2000/svg";
function element(tag, attributes, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderPointTrend(svg, samples, activeCycle, scale, message) {
  svg.replaceChildren();
  const [left, right, top, bottom] = [33, 218, 12, 91];
  const text = (x, y, value, anchor = "middle") => element("text", {x, y, "text-anchor": anchor}, value);
  svg.append(element("rect", {class: "trend-background", x: 1, y: 1, width: 230, height: 116, rx: 5}));
  if (!samples.some(point => Number.isFinite(point.value))) {
    svg.setAttribute("aria-label", message);
    svg.append(text(116, 62, message));
    return;
  }

  const values = samples.filter(point => Number.isFinite(point.value)).map(point => point.value);
  const low = Math.min(...values), high = Math.max(...values);
  const pad = Math.max(.25, (high - low) * .12);
  const min = low - pad, max = high + pad;
  const start = +cycleDate(samples[0].cycle), end = +cycleDate(samples.at(-1).cycle);
  const x = cycle => start === end ? (left + right) / 2 : left + (cycleDate(cycle) - start) * (right - left) / (end - start);
  const y = value => bottom - (value - min) * (bottom - top) / (max - min);
  const number = value => Number(value.toFixed(1)).toString();
  for (const value of [min, (min + max) / 2, max]) {
    const row = y(value);
    svg.append(element("line", {class: "trend-grid", x1: left, y1: row, x2: right, y2: row}),
      text(left - 5, row + 3, number(value), "end"));
  }
  const cycleLabel = cycle => cycle.slice(6, 8) + "/" + cycle.slice(4, 6) + " " + cycle.slice(9, 11) + "Z";
  if (start === end) {
    svg.append(text(x(samples[0].cycle), 108, cycleLabel(samples[0].cycle)));
  } else {
    svg.append(text(left, 108, cycleLabel(samples[0].cycle), "start"),
      text(right, 108, cycleLabel(samples.at(-1).cycle), "end"));
  }
  let line = "", connected = false;
  for (const point of samples) {
    if (!Number.isFinite(point.value)) {
      connected = false;
      continue;
    }
    line += (connected ? " L " : " M ") + x(point.cycle) + " " + y(point.value);
    connected = true;
  }
  svg.append(element("path", {class: "trend-line", d: line}));
  for (const point of samples) {
    if (!Number.isFinite(point.value)) continue;
    const active = point.cycle === activeCycle;
    const marker = element("circle", {class: active ? "trend-marker current" : "trend-marker",
      cx: x(point.cycle), cy: y(point.value), r: active ? 4 : 2.5});
    marker.append(element("title", {}, formatTime(cycleDate(point.cycle)) + " · F" + String(point.lead).padStart(3, "0")
      + " · " + number(point.value) + " " + scale.unit));
    svg.append(marker);
  }
  svg.setAttribute("aria-label", scale.label + " by run initialization in UTC. " + samples
    .filter(point => Number.isFinite(point.value))
    .map(point => formatTime(cycleDate(point.cycle)) + " " + number(point.value) + " " + scale.unit).join(". "));
}
