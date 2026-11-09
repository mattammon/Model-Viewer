import { ForecastMap, HEIGHT_CONTOUR_INTERVAL } from "./map.js";
import { availableValidTimes, cycleDate, formatTime, formatValidTime, framesAt, matchedRuns, renderPointTrend, validTime } from "./trend.js";

const WIND_SPEED = {unit: "m/s", ticks: [0, 6, 12, 18, 24, 30], spread: 12, colors: ["#26354e", "#355a84", "#388c9e", "#5cbd8a", "#d1cc63", "#f0a348", "#d75350", "#974068"]};
const TEMPERATURE_INTERVAL = 5;
const TEMPERATURE_LINES = ["#312979", "#2447ad", "#1b68bd", "#087891", "#00725a", "#477629", "#8b6500", "#a54f00", "#bb3219", "#a32035", "#791b49"];
const FIELDS = {
  t2m: {label: "2 m temperature", unit: "°C", ticks: [-20, -10, 0, 10, 20, 30], convert: value => value - 273.15, spread: 12, colors: ["#5e2a8d", "#27429d", "#4a8ddd", "#94cdd5", "#b8d486", "#e2c45c", "#ed853e", "#c44b48", "#862d50"]},
  t850: {label: "850 hPa temperature", unit: "°C", ticks: [-45, -30, -15, 0, 15, 30], convert: value => value - 273.15, spread: 12, colors: ["#5e2a8d", "#27429d", "#4a8ddd", "#94cdd5", "#b8d486", "#e2c45c", "#ed853e", "#c44b48", "#862d50"]},
  mslp: {label: "Mean sea-level pressure", unit: "hPa", ticks: [960, 980, 1000, 1020, 1040], convert: value => value / 100, spread: 20, colors: ["#63308f", "#4366ab", "#6dbac8", "#c9d9ae", "#e4c368", "#ce7b42", "#a34a48"]},
  ws10: {...WIND_SPEED, label: "10 m wind"},
  ws100: {...WIND_SPEED, label: "100 m wind", ticks: [0, 8, 16, 24, 32, 40]},
  ws850: {...WIND_SPEED, label: "850 hPa wind", ticks: [0, 10, 20, 30, 40, 50], spread: 18},
  z500_anom: {label: "500 hPa height anomaly", unit: "m", ticks: [-400, -200, 0, 200, 400], colors: ["#293879", "#4177b3", "#a5cbe5", "#e9e6d9", "#e9b18e", "#c86247", "#8c2d43"]},
  u10: {label: "10 m zonal wind", unit: "m/s", ticks: [-30, -20, -10, 0, 10, 20, 30], spread: 12, colors: ["#3b2d83", "#4775b6", "#75b9cd", "#d0e0da", "#e3be72", "#d77b49", "#9d4152"]},
  v10: {label: "10 m meridional wind", unit: "m/s", ticks: [-30, -20, -10, 0, 10, 20, 30], spread: 12, colors: ["#3b2d83", "#4775b6", "#75b9cd", "#d0e0da", "#e3be72", "#d77b49", "#9d4152"]},
  z500: {label: "500 hPa geopotential height", unit: "m", ticks: [4800, 5100, 5400, 5700, 6000], spread: 180, colors: ["#4f317e", "#3d5ca9", "#5ca0c8", "#82bca9", "#bcd478", "#d9c264", "#d97b44", "#9e3e51"]},
};

const PRODUCTS = {
  mean: "Ensemble mean",
  spread: "Ensemble spread",
  p10: "10th percentile",
  p50: "50th percentile",
  p90: "90th percentile",
};
const $ = id => document.getElementById(id);
const IFS = "ifs_ens", AIFS = "aifs_ens";
const state = {catalog: null, model: null, run: null, lead: null, field: "t2m", product: "mean", point: null, domain: "europe", showBarbs: true, mode: "forecast", trendValid: null, compare: false};
const frames = new Map();
const pointTrends = new Map();
let fieldRequest, pointRequest, catalogRequest, trendRequest;
let playing = false;
let playToken = 0;
let playTimer;
const map = new ForecastMap($("map"), selectPoint, bounds => syncViewport(bounds, comparisonMap));
const comparisonMap = new ForecastMap($("compare-map"), selectPoint, bounds => syncViewport(bounds, map));

function syncViewport(bounds, peer) {
  $("map-tag").textContent = "CUSTOM VIEW";
  if (state.compare) peer.setViewport(bounds);
}

async function getJSON(path, signal) {
  const response = await fetch(path, {signal, cache: "no-store"});
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function setOptions(select, options, current) {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  if (options.some(([value]) => String(value) === String(current))) select.value = current;
  select.disabled = options.length < 2;
}

function leadLabel(lead) {
  return "F" + String(lead).padStart(3, "0");
}

function selectedModel(id = state.model) {
  return state.catalog?.models.find(model => model.id === id);
}

function displayedModels() {
  return state.compare ? [IFS, AIFS] : [state.model];
}

function selectedRun() {
  return modelRuns().find(run => run.cycle === state.run);
}

function usableLeads() {
  return selectedRun()?.compiled_leads || [];
}

function modelRuns() {
  const runs = selectedModel()?.runs || [];
  return state.compare ? matchedRuns(runs, selectedModel(AIFS)?.runs || []) : runs;
}

function displayedValidTime() {
  return validTime(state.run, state.lead);
}

function selectTrendFrame() {
  const runs = modelRuns();
  const times = availableValidTimes(runs);
  if (!times.some(([time]) => time === state.trendValid)) {
    const displayed = displayedValidTime();
    state.trendValid = times.find(([time]) => time === displayed)?.[0]
      ?? times.find(([, count]) => count > 1)?.[0] ?? times[0]?.[0] ?? null;
  }
  const matches = framesAt(runs, state.trendValid);
  const selected = matches.find(frame => frame.cycle === state.run) || matches.at(-1);
  if (selected) {
    state.run = selected.cycle;
    state.lead = selected.lead;
  }
}

function fieldOptions() {
  const fields = state.catalog?.fields || {};
  return Object.keys(fields).filter(key => key in FIELDS && !(key === "z500_anom" && "z500" in fields))
    .map(key => [key, hasHeightOverlay(key) ? "500 hPa height and anomaly" : FIELDS[key].label]);
}

function hasHeightOverlay(field = state.field) {
  return field === "z500" && Boolean(state.catalog?.fields?.z500_anom);
}

function shadingField() {
  return hasHeightOverlay() ? "z500_anom" : state.field;
}

function windDirectionField() {
  if (!state.field.startsWith("ws")) return null;
  const direction = "wd" + state.field.slice(2);
  return state.catalog?.fields?.[direction] ? direction : null;
}

function barbProduct() {
  return selectedModel()?.ensemble && !state.product.startsWith("member-") ? "mean" : state.product;
}

function productOptions(model) {
  if (!model) return [];
  if (!model.ensemble) return [["deterministic", "Deterministic"]];
  const summaryOnly = Boolean(state.catalog?.member_wind_bounds);
  const options = Object.entries(PRODUCTS).filter(([key]) => shadingField() !== "z500_anom" || key !== "spread");
  if (!summaryOnly) {
    for (const member of model.configured_members || []) {
      options.push(["member-" + member, member === 0 ? "Control member" : "Member " + String(member).padStart(2, "0")]);
    }
  }
  return options;
}

function selectDefaults(modelChanged = false) {
  const models = state.catalog?.models || [];
  if (state.compare) state.model = IFS;
  else if (!selectedModel()) state.model = (models.find(m => m.id === IFS && m.runs.some(r => r.compiled_leads.length)) || models.find(m => m.runs.some(r => r.compiled_leads.length)) || models[0])?.id;
  const model = selectedModel();
  const runs = modelRuns();
  if (!selectedRun() || modelChanged) {
    state.run = runs.find(r => r.compiled_leads.length)?.cycle || runs[0]?.cycle;
  }
  if (!usableLeads().includes(state.lead)) state.lead = usableLeads()[0] ?? null;
  if (state.mode === "trend") selectTrendFrame();
  const fields = fieldOptions();
  if (!fields.some(([key]) => key === state.field)) state.field = fields[0]?.[0] || "t2m";
  if (!productOptions(model).some(([key]) => key === state.product)) state.product = model?.ensemble ? "mean" : "deterministic";
}

function scaleFor(field, product) {
  const def = FIELDS[field];
  const label = field.startsWith("ws") ? def.label + " speed" : def.label;
  if (product === "spread") {
    const ticks = [0, .25, .5, .75, 1].map(n => n * def.spread);
    return {
      label: label + " spread",
      unit: def.unit === "°C" ? "K" : def.unit,
      ticks,
      min: 0,
      max: def.spread,
      colors: ["#252f52", "#3c5697", "#4391b1", "#7fc8ab", "#e1c870", "#e5804f"],
      convert: field === "mslp" ? value => value / 100 : value => value,
    };
  }
  return {...def, label, min: def.ticks[0], max: def.ticks.at(-1), convert: def.convert || (value => value)};
}

function requestParams(field, product = state.product, {cycle = state.run, lead = state.lead, model = state.model} = {}) {
  const params = new URLSearchParams({model, cycle, lead, field});
  if (product.startsWith("member-")) params.set("member", product.slice(7));
  else if (product !== "deterministic") params.set("stat", product);
  return params;
}

async function getFrame(field, product, signal, model) {
  const params = requestParams(field, product, {model});
  params.set("width", "480");
  const key = params.toString();
  if (frames.has(key)) return frames.get(key);
  const grid = await getJSON("/api/field?" + key, signal);
  if (!signal.aborted) {
    frames.set(key, grid);
    if (frames.size > 12) frames.delete(frames.keys().next().value);
  }
  return grid;
}

function pointParams(field, product, point, frame) {
  const params = requestParams(field, product, frame);
  params.set("lat", point.lat);
  params.set("lon", point.lon);
  return params;
}

function setMessage(message, id = "map-message") {
  $(id).textContent = message || "";
  $(id).hidden = !message;
}

function setCatalogBadge(mode, label) {
  $("catalog-state").dataset.state = mode;
  $("catalog-state").querySelector("span").textContent = label;
}

function drawControls() {
  const model = selectedModel();
  const run = selectedRun();
  const modelOptions = (state.catalog?.models || []).map(m => [m.id, m.label]);
  if (selectedModel(IFS) && selectedModel(AIFS)) modelOptions.push(["compare", "IFS + AIFS side by side"]);
  setOptions($("model"), modelOptions, state.compare ? "compare" : state.model);
  setOptions($("cycle"), modelRuns().map(r => [r.cycle, formatTime(cycleDate(r.cycle)) + (r.status === "partial" ? " · partial" : "")]), state.run);
  $("map-panels").classList.toggle("comparison", state.compare);
  $("compare-pane").hidden = !state.compare;
  $("primary-pane-title").hidden = !state.compare;
  $("trend-key").hidden = !state.compare;
  setOptions($("field"), fieldOptions(), state.field);
  $("wind-barb-controls").hidden = !windDirectionField();
  setOptions($("product"), productOptions(model), state.product);
  const parts = [];
  if (model) parts.push(model.resolution.replace("p", ".") + "° source grid");
  if (state.compare) parts.push("Matching initializations and valid times");
  else if (model?.ensemble) parts.push(model.configured_members.length + " / " + model.ensemble_size + " members configured");
  if (run) parts.push(run.compiled_leads.length + " / " + run.leads.length + " leads compiled");
  $("coverage").textContent = parts.join(" · ") || "Waiting for the forecast catalog.";
}

function timelineFrames() {
  if (state.mode === "trend") {
    return framesAt(modelRuns(), state.trendValid).map(frame => ({
      ...frame, key: frame.cycle,
      label: formatTime(cycleDate(frame.cycle)).replace(":00 UTC", "Z") + " · " + leadLabel(frame.lead),
      title: "Initialized " + formatTime(cycleDate(frame.cycle)) + " · " + leadLabel(frame.lead),
      available: true,
    }));
  }
  const leads = usableLeads();
  return (selectedRun()?.leads || []).map(lead => ({
    cycle: state.run, lead, key: String(lead), label: leadLabel(lead),
    title: leads.includes(lead) ? "Forecast hour " + lead : "Lead pending compilation",
    available: leads.includes(lead),
  }));
}

function activeFrameKey() {
  return state.mode === "trend" ? state.run : String(state.lead);
}

function drawTimeline() {
  const trend = state.mode === "trend";
  const items = timelineFrames();
  const available = items.filter(frame => frame.available);
  const strip = $("leads");
  const key = activeFrameKey();
  $("trend-picker").hidden = !trend;
  if (trend) {
    const times = availableValidTimes(modelRuns());
    const select = $("trend-valid");
    const layout = JSON.stringify(times);
    if (select.dataset.layout !== layout) {
      setOptions(select, times.map(([time, count]) =>
        [time, formatValidTime(new Date(time)) + " · " + count + (count === 1 ? " run" : " runs")]), state.trendValid);
      select.dataset.layout = layout;
    } else if (state.trendValid !== null) {
      select.value = String(state.trendValid);
    }
  }
  $("timeline-title").textContent = trend ? "Run-to-run timeline" : "Forecast timeline";
  strip.setAttribute("aria-label", trend ? "Run initializations" : "Forecast lead hours");
  // Keep buttons in place during playback so focus and scrolling are preserved.
  const layout = state.mode + JSON.stringify(items.map(({cycle, lead, available}) => [cycle, lead, available]));
  if (strip.dataset.layout !== layout) {
    strip.replaceChildren(...items.map(frame => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.key = frame.key;
      button.textContent = frame.label;
      button.title = frame.title;
      button.disabled = !frame.available;
      button.addEventListener("click", () => changeFrame(frame));
      return button;
    }));
    strip.dataset.layout = layout;
  }
  for (const button of strip.children) button.setAttribute("aria-pressed", String(button.dataset.key === key));
  const active = strip.querySelector('[aria-pressed="true"]');
  if (active) {
    if (active.offsetLeft < strip.offsetLeft + strip.scrollLeft) strip.scrollLeft = active.offsetLeft - strip.offsetLeft;
    else if (active.offsetLeft + active.offsetWidth > strip.offsetLeft + strip.scrollLeft + strip.clientWidth) strip.scrollLeft = active.offsetLeft + active.offsetWidth - strip.offsetLeft - strip.clientWidth + 4;
  }
  $("timeline-info").textContent = trend
    ? available.length + (available.length === 1 ? " run" : " runs") + " for this valid time"
    : selectedRun() ? available.length + " of " + items.length + " leads available" : "Waiting for compiled leads";
  const index = available.findIndex(frame => frame.key === key);
  $("play").disabled = available.length < 2;
  $("prev-lead").disabled = index < 1;
  $("next-lead").disabled = index < 0 || index >= available.length - 1;
}

function drawHeader() {
  const model = selectedModel();
  const product = productOptions(model).find(([key]) => key === state.product)?.[1];
  const scale = scaleFor(shadingField(), state.product);
  $("map-title").textContent = hasHeightOverlay() ? "500 hPa geopotential height and anomaly" : scale.label;
  $("map-model").textContent = model ? (state.compare ? "IFS ENS + AIFS ENS" : model.label) + " / " + product : "FORECAST MAP";
  $("legend-title").textContent = scale.label + " · " + scale.unit;
  const overlay = $("overlay-legend");
  overlay.textContent = hasHeightOverlay() ? "Black contours show heights every " + HEIGHT_CONTOUR_INTERVAL + " m"
    : windDirectionField() && state.showBarbs
      ? (barbProduct() === "mean" ? "Barbs show mean speed and circular mean direction · kt" : "Barbs show wind speed and direction · kt")
      : state.field === "t2m" && state.product !== "spread" ? "Colored temperature contours every 5 °C" : "";
  overlay.hidden = !overlay.textContent;
  $("legend-bar").style.background = "linear-gradient(90deg, " + scale.colors.join(", ") + ")";
  $("legend-ticks").replaceChildren(...scale.ticks.map(value => {
    const span = document.createElement("span");
    span.textContent = Number(value.toFixed(1));
    return span;
  }));
  const valid = displayedValidTime();
  $("valid-time").textContent = valid === null ? "—" : formatValidTime(new Date(valid));
  $("map-details").textContent = state.lead !== null ? leadLabel(state.lead) + (shadingField() === "z500_anom" ? " · NOAA PSL 1991–2020 daily normal" : " · latitude / longitude") : "";
}

async function drawMap(target, messageId, model, signal) {
  target.setWindOverlay(null);
  target.setContourOverlay(null);
  target.setField(null);
  if (!state.run || state.lead === null) {
    const message = state.compare ? "Waiting for a lead compiled by both models."
      : state.catalog?.models?.length ? "This run has no compiled forecast leads yet."
        : "Waiting for forecasts. Start the ingestion worker to populate the catalog.";
    setMessage(message, messageId);
    return;
  }
  const field = shadingField();
  const product = state.product;
  let grid;
  try {
    setMessage("Loading " + leadLabel(state.lead) + " forecast…", messageId);
    grid = await getFrame(field, product, signal, model);
    if (signal.aborted) return;
    const scale = scaleFor(field, product);
    target.setField(grid, scale);
    if (field === "t2m" && product !== "spread") {
      target.setContourOverlay(grid, {
        interval: TEMPERATURE_INTERVAL,
        convert: scale.convert,
        color: level => TEMPERATURE_LINES[Math.max(0, Math.min(TEMPERATURE_LINES.length - 1, (level + 20) / TEMPERATURE_INTERVAL))],
        halo: true,
      });
    }
    setMessage(null, messageId);
  } catch (error) {
    if (signal.aborted) return;
    target.setField(null);
    setMessage("Forecast unavailable. " + error.message, messageId);
    return;
  }
  try {
    if (hasHeightOverlay()) {
      const height = await getFrame("z500", product, signal, model);
      if (!signal.aborted) target.setContourOverlay(height);
    } else if (state.showBarbs && windDirectionField()) {
      const windProduct = barbProduct();
      const [speed, direction] = await Promise.all([
        product === windProduct ? grid : getFrame(field, windProduct, signal, model),
        getFrame(windDirectionField(), windProduct, signal, model),
      ]);
      if (!signal.aborted) target.setWindOverlay({speed, direction});
    }
  } catch (error) {
    if (!signal.aborted) {
      const modelLabel = state.compare ? " for " + (model === IFS ? "IFS ENS" : "AIFS ENS") : "";
      $("overlay-legend").textContent = "Overlay unavailable" + modelLabel + ". " + error.message;
      $("overlay-legend").hidden = false;
    }
  }
}

async function drawField() {
  fieldRequest?.abort();
  const controller = new AbortController();
  fieldRequest = controller;
  drawHeader();
  drawTimeline();
  const primary = drawMap(map, "map-message", state.model, controller.signal);
  if (state.compare) {
    await Promise.all([primary, drawMap(comparisonMap, "compare-map-message", AIFS, controller.signal)]);
  } else {
    await primary;
  }
}

async function updatePointTrend() {
  const chart = $("point-trend-chart");
  const caption = $("point-trend-caption");
  const valid = displayedValidTime();
  const point = state.point;
  if (!point || valid === null) {
    trendRequest?.controller.abort();
    trendRequest = null;
    caption.textContent = "Forecast valid time";
    renderPointTrend(chart, [], state.run, null, point ? "Waiting for forecasts" : "Select a point on the map");
    return;
  }

  const field = shadingField(), product = state.product;
  const scale = scaleFor(field, product);
  const series = displayedModels().map(model => ({
    model,
    label: state.compare ? (model === IFS ? "IFS ENS" : "AIFS ENS") : selectedModel(model)?.label || model,
    style: state.compare && model === AIFS ? "aifs" : "ifs",
    points: [],
  }));
  const samples = series.flatMap(line => framesAt(selectedModel(line.model)?.runs || [], valid)
    .map(frame => ({...frame, model: line.model, line})));
  const requests = samples.map(frame => pointParams(field, product, point, frame).toString());
  const key = String(state.compare) + "|" + requests.join("|");
  const show = (lines, message = "No values for this valid time") => {
    const hasValues = lines.some(line => line.points.some(sample => Number.isFinite(sample.value)));
    caption.textContent = formatValidTime(new Date(valid)) + (hasValues ? " · " + scale.unit : "");
    renderPointTrend(chart, lines, state.run, scale, message);
  };
  if (trendRequest?.key === key) return;
  trendRequest?.controller.abort();
  trendRequest = null;
  if (pointTrends.has(key)) {
    show(pointTrends.get(key));
    return;
  }
  if (!requests.length) {
    show([]);
    return;
  }

  const controller = new AbortController();
  trendRequest = {key, controller};
  show([], "Loading run history…");
  const responses = await Promise.allSettled(requests.map(query => getJSON("/api/point?" + query, controller.signal)));
  if (controller.signal.aborted) return;
  trendRequest = null;
  for (const [index, {cycle, lead, line}] of samples.entries()) {
    const result = responses[index];
    const value = result.status === "fulfilled" ? result.value.value : null;
    line.points.push({cycle, lead, value: Number.isFinite(value) ? scale.convert(value) : null});
  }
  if (responses.every(result => result.status === "fulfilled")) {
    pointTrends.set(key, series);
    if (pointTrends.size > 48) pointTrends.delete(pointTrends.keys().next().value);
  }
  show(series);
}

async function drawPoint() {
  updatePointTrend();
  pointRequest?.abort();
  if (!state.point) {
    $("probe-hint").hidden = false;
    $("probe-hint").textContent = "Select a point on the map to sample the forecast grid.";
    $("probe-result").hidden = true;
    $("clear-point").hidden = true;
    return;
  }
  $("clear-point").hidden = false;
  $("probe-result").hidden = true;
  $("probe-overlay").hidden = true;
  $("probe-compare-overlay").hidden = true;
  $("probe-hint").hidden = false;
  if (state.lead === null) {
    $("probe-hint").textContent = "A compiled forecast lead is required.";
    return;
  }
  $("probe-hint").textContent = "Sampling the source grid…";
  const controller = new AbortController();
  pointRequest = controller;
  const point = state.point;
  const field = shadingField();
  const product = state.product;
  const models = displayedModels();
  const results = await Promise.allSettled(models.map(model =>
    getJSON("/api/point?" + pointParams(field, product, point, {model}), controller.signal)));
  if (controller.signal.aborted) return;
  const sampled = results.find(result => result.status === "fulfilled")?.value;
  if (!sampled) {
    $("probe-hint").textContent = "Point unavailable. " + results[0].reason.message;
    return;
  }
  const scale = scaleFor(field, product);
  const pointValue = result => {
    if (result.status === "rejected") return "Unavailable";
    const {value} = result.value;
    return value === null ? "Missing" : scale.convert(value).toFixed(field === "z500" ? 0 : 1) + " " + scale.unit;
  };
  $("probe-label").textContent = scale.label;
  $("probe-value").textContent = pointValue(results[0]);
  $("probe-primary-model").hidden = !state.compare;
  $("probe-compare").hidden = !state.compare;
  if (state.compare) $("probe-compare-value").textContent = pointValue(results[1]);
  $("probe-coordinates").textContent = sampled.latitude.toFixed(2) + "°, " + sampled.longitude.toFixed(2) + "° · grid point";
  $("probe-result").hidden = false;
  $("probe-hint").hidden = true;
  const location = {lat: sampled.latitude, lon: sampled.longitude};
  map.setPoint(location);
  comparisonMap.setPoint(location);

  const height = hasHeightOverlay();
  const extraField = height ? "z500" : windDirectionField();
  if (!extraField) return;
  const extraProduct = height ? product : barbProduct();
  await Promise.all(models.map(async (model, index) => {
    if (results[index].status !== "fulfilled") return;
    const detail = $(index === 0 ? "probe-overlay" : "probe-compare-overlay");
    try {
      const {value} = await getJSON("/api/point?" + pointParams(extraField, extraProduct, point, {model}), controller.signal);
      if (controller.signal.aborted || value === null) return;
      const label = height ? "Height " : extraProduct === "mean" ? "Mean direction " : "Direction ";
      detail.textContent = label + (height ? value.toFixed(0) + " m" : Math.round(value) % 360 + "° from");
    } catch (error) {
      if (controller.signal.aborted) return;
      detail.textContent = "Overlay value unavailable";
    }
    detail.hidden = false;
  }));
}

function selectPoint(point) {
  state.point = point;
  map.setPoint(point);
  comparisonMap.setPoint(point);
  drawPoint();
}

function refreshSelection() {
  drawControls();
  drawField();
  drawPoint();
}

async function refreshCatalog(manual = false) {
  catalogRequest?.abort();
  const controller = new AbortController();
  catalogRequest = controller;
  $("refresh-catalog").disabled = true;
  try {
    const data = await getJSON("/api/catalog", controller.signal);
    if (controller.signal.aborted) return;
    const previous = [state.model, state.run, state.lead, state.field, state.product].join("/");
    const oldBounds = JSON.stringify(state.catalog?.bounds);
    state.catalog = data;
    if (data.bounds && oldBounds !== JSON.stringify(data.bounds)) {
      setOptions($("region"), [["europe", "Europe and surroundings"]], "europe");
      state.domain = "europe";
      resetDomain();
    }
    selectDefaults();
    const current = [state.model, state.run, state.lead, state.field, state.product].join("/");
    const newest = Date.parse(data.generated_at);
    if (!Number.isFinite(newest)) setCatalogBadge("waiting", "Waiting for data");
    else if (Date.now() - newest > 60 * 60000) setCatalogBadge("stale", "Older catalog");
    else setCatalogBadge("ready", "Catalog ready");
    $("catalog-state").title = Number.isFinite(newest) ? "Catalog updated " + formatTime(new Date(newest)) : "No forecast catalog has been published yet";
    if (manual) {
      frames.clear();
      pointTrends.clear();
      trendRequest?.controller.abort();
      trendRequest = null;
    }
    if (manual || previous !== current || !data.models?.length) refreshSelection();
    else {
      drawControls();
      drawTimeline();
      updatePointTrend();
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    setCatalogBadge("waiting", "Catalog unavailable");
    if (!state.catalog) setMessage("Could not load the forecast catalog. " + error.message);
  } finally {
    if (!controller.signal.aborted) $("refresh-catalog").disabled = false;
  }
}

function setPlayback(on) {
  playing = on;
  playToken++;
  clearTimeout(playTimer);
  $("play").querySelector("use").setAttribute("href", on ? "#pause-icon" : "#play-icon");
  $("play").title = on ? "Pause forecast" : "Play forecast";
  $("play").setAttribute("aria-label", $("play").title);
}

async function changeFrame(frame, pause = true) {
  if (!frame?.available) return;
  if (pause) setPlayback(false);
  const changedRun = state.run !== frame.cycle;
  state.run = frame.cycle;
  state.lead = frame.lead;
  if (changedRun) drawControls();
  await Promise.all([drawField(), drawPoint()]);
}

function stepFrame(offset) {
  const items = timelineFrames().filter(frame => frame.available);
  const index = items.findIndex(frame => frame.key === activeFrameKey());
  if (index !== -1) changeFrame(items[index + offset]);
}

function play() {
  setPlayback(!playing);
  if (!playing) return;
  const token = playToken;
  const tick = async () => {
    if (!playing || token !== playToken) return;
    const items = timelineFrames().filter(frame => frame.available);
    if (items.length < 2) {
      setPlayback(false);
      return;
    }
    const index = items.findIndex(frame => frame.key === activeFrameKey());
    await changeFrame(items[(index + 1) % items.length], false);
    if (playing && token === playToken) playTimer = setTimeout(tick, 700);
  };
  tick();
}

function resetDomain() {
  map.setDomain(state.domain, state.catalog?.bounds);
  comparisonMap.setDomain(state.domain, state.catalog?.bounds);
  $("map-tag").textContent = $("region").selectedOptions[0].text.toUpperCase() + " · LAT / LON";
}

$("model").addEventListener("change", () => {
  setPlayback(false);
  state.compare = $("model").value === "compare";
  state.model = state.compare ? IFS : $("model").value;
  if (state.compare) comparisonMap.setViewport(map.bounds);
  selectDefaults(!state.compare);
  refreshSelection();
});
$("cycle").addEventListener("change", () => {
  setPlayback(false);
  state.run = $("cycle").value;
  selectDefaults();
  refreshSelection();
});
for (const id of ["field", "product"]) {
  $(id).addEventListener("change", () => {
    setPlayback(false);
    state[id] = $(id).value;
    selectDefaults();
    refreshSelection();
  });
}
$("show-barbs").addEventListener("change", event => {
  state.showBarbs = event.target.checked;
  drawField();
});
for (const id of ["barb-size", "barb-spacing"]) {
  $(id).addEventListener("input", () => {
    $(id + "-value").textContent = $(id).value + " px";
    const size = Number($("barb-size").value), spacing = Number($("barb-spacing").value);
    map.setBarbStyle(size, spacing);
    comparisonMap.setBarbStyle(size, spacing);
  });
}
$("region").addEventListener("change", () => { state.domain = $("region").value; resetDomain(); });
$("reset-map").addEventListener("click", resetDomain);
$("zoom-in").addEventListener("click", () => map.zoom(.72));
$("zoom-out").addEventListener("click", () => map.zoom(1.39));
$("clear-point").addEventListener("click", () => selectPoint(null));
$("timeline-mode").addEventListener("change", event => {
  setPlayback(false);
  state.mode = event.target.value;
  if (state.mode === "trend") state.trendValid = displayedValidTime();
  selectDefaults();
  refreshSelection();
});
$("trend-valid").addEventListener("change", event => {
  setPlayback(false);
  state.trendValid = Number(event.target.value);
  selectTrendFrame();
  refreshSelection();
});
$("prev-lead").addEventListener("click", () => stepFrame(-1));
$("next-lead").addEventListener("click", () => stepFrame(1));
$("play").addEventListener("click", play);
$("refresh-catalog").addEventListener("click", () => refreshCatalog(true));

getJSON("/viewer/boundaries.json").then(layers => {
  map.setBoundaries(layers);
  comparisonMap.setBoundaries(layers);
}).catch(() => {
  for (const label of document.querySelectorAll(".attribution")) label.textContent = "Map boundaries unavailable";
});
resetDomain();
refreshCatalog();
setInterval(() => refreshCatalog(), 60000);
