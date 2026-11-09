import { ForecastMap, HEIGHT_CONTOUR_INTERVAL } from "./map.js";

const WIND_SPEED = {unit: "m/s", ticks: [0, 6, 12, 18, 24, 30], spread: 12, colors: ["#26354e", "#355a84", "#388c9e", "#5cbd8a", "#d1cc63", "#f0a348", "#d75350", "#974068"]};
const FIELDS = {
  t2m: {label: "2 m temperature", unit: "°C", ticks: [-60, -40, -20, 0, 20, 40], convert: value => value - 273.15, spread: 12, colors: ["#5e2a8d", "#27429d", "#4a8ddd", "#94cdd5", "#b8d486", "#e2c45c", "#ed853e", "#c44b48", "#862d50"]},
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
const state = {catalog: null, model: null, run: null, lead: null, field: "t2m", product: "mean", point: null, domain: "europe", showBarbs: true};
const frames = new Map();
let fieldRequest, pointRequest, catalogRequest;
let playing = false;
let playToken = 0;
let playTimer;
const map = new ForecastMap($("map"), selectPoint, () => { $("map-tag").textContent = "CUSTOM VIEW"; });

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

function cycleDate(cycle) {
  return new Date(cycle.slice(0, 4) + "-" + cycle.slice(4, 6) + "-" + cycle.slice(6, 8) + "T" + cycle.slice(9, 11) + ":00:00Z");
}

const utcDate = new Intl.DateTimeFormat("en-GB", {timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"});
function formatTime(date) {
  return utcDate.format(date).replace(",", " ·") + " UTC";
}

function leadLabel(lead) {
  return "F" + String(lead).padStart(3, "0");
}

function selectedModel() {
  return state.catalog?.models.find(model => model.id === state.model);
}

function selectedRun() {
  return selectedModel()?.runs.find(run => run.cycle === state.run);
}

function usableLeads() {
  return selectedRun()?.compiled_leads || [];
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
  if (!selectedModel()) state.model = (models.find(m => m.id === "ifs_ens" && m.runs.some(r => r.compiled_leads.length)) || models.find(m => m.runs.some(r => r.compiled_leads.length)) || models[0])?.id;
  const model = selectedModel();
  if (!selectedRun() || modelChanged) {
    state.run = model?.runs.find(r => r.compiled_leads.length)?.cycle || model?.runs[0]?.cycle;
  }
  if (!usableLeads().includes(state.lead)) state.lead = usableLeads()[0] ?? null;
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

function requestParams(field, product = state.product) {
  const params = new URLSearchParams({model: state.model, cycle: state.run, lead: state.lead, field});
  if (product.startsWith("member-")) params.set("member", product.slice(7));
  else if (product !== "deterministic") params.set("stat", product);
  return params;
}

async function getFrame(field, product, signal) {
  const params = requestParams(field, product);
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

function pointParams(field, product, point) {
  const params = requestParams(field, product);
  params.set("lat", point.lat);
  params.set("lon", point.lon);
  return params;
}

function setMessage(message) {
  $("map-message").textContent = message || "";
  $("map-message").hidden = !message;
}

function setCatalogBadge(mode, label) {
  $("catalog-state").dataset.state = mode;
  $("catalog-state").querySelector("span").textContent = label;
}

function drawControls() {
  const model = selectedModel();
  const run = selectedRun();
  setOptions($("model"), (state.catalog?.models || []).map(m => [m.id, m.label]), state.model);
  setOptions($("cycle"), (model?.runs || []).map(r => [r.cycle, formatTime(cycleDate(r.cycle)) + (r.status === "partial" ? " · partial" : "")]), state.run);
  setOptions($("field"), fieldOptions(), state.field);
  $("wind-barb-controls").hidden = !windDirectionField();
  setOptions($("product"), productOptions(model), state.product);
  const parts = [];
  if (model) parts.push(model.resolution.replace("p", ".") + "° source grid");
  if (model?.ensemble) parts.push(model.configured_members.length + " / " + model.ensemble_size + " members configured");
  if (run) parts.push(run.compiled_leads.length + " / " + run.leads.length + " leads compiled");
  $("coverage").textContent = parts.join(" · ") || "Waiting for the forecast catalog.";
}

function drawTimeline() {
  const run = selectedRun();
  const leads = usableLeads();
  const strip = $("leads");
  const planned = run?.leads || [];
  // Keep the timeline buttons in place on lead changes so keyboard focus stays put.
  const layout = planned.map(lead => lead + ":" + leads.includes(lead)).join(",");
  if (strip.dataset.layout !== layout) {
    strip.replaceChildren(...planned.map(lead => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.lead = lead;
      button.textContent = leadLabel(lead);
      button.disabled = !leads.includes(lead);
      button.title = button.disabled ? "Lead pending compilation" : "Forecast hour " + lead;
      button.addEventListener("click", () => changeLead(lead));
      return button;
    }));
    strip.dataset.layout = layout;
  }
  for (const button of strip.children) button.setAttribute("aria-pressed", String(Number(button.dataset.lead) === state.lead));
  const active = strip.querySelector('[aria-pressed="true"]');
  if (active) {
    if (active.offsetLeft < strip.offsetLeft + strip.scrollLeft) strip.scrollLeft = active.offsetLeft - strip.offsetLeft;
    else if (active.offsetLeft + active.offsetWidth > strip.offsetLeft + strip.scrollLeft + strip.clientWidth) strip.scrollLeft = active.offsetLeft - strip.offsetLeft + active.offsetWidth - strip.clientWidth + 4;
  }
  $("timeline-info").textContent = run ? leads.length + " of " + planned.length + " leads available" : "Waiting for compiled leads";
  $("play").disabled = leads.length < 2;
  $("prev-lead").disabled = leads.indexOf(state.lead) < 1;
  $("next-lead").disabled = leads.indexOf(state.lead) >= leads.length - 1;
}

function drawHeader() {
  const model = selectedModel();
  const product = productOptions(model).find(([key]) => key === state.product)?.[1];
  const scale = scaleFor(shadingField(), state.product);
  $("map-title").textContent = hasHeightOverlay() ? "500 hPa geopotential height and anomaly" : scale.label;
  $("map-model").textContent = model ? model.label + " / " + product : "FORECAST MAP";
  $("legend-title").textContent = scale.label + " · " + scale.unit;
  const overlay = $("overlay-legend");
  overlay.textContent = hasHeightOverlay() ? "Black contours show heights every " + HEIGHT_CONTOUR_INTERVAL + " m"
    : windDirectionField() && state.showBarbs
      ? (barbProduct() === "mean" ? "Barbs show mean speed and circular mean direction · kt" : "Barbs show wind speed and direction · kt")
      : "";
  overlay.hidden = !overlay.textContent;
  $("legend-bar").style.background = "linear-gradient(90deg, " + scale.colors.join(", ") + ")";
  $("legend-ticks").replaceChildren(...scale.ticks.map(value => {
    const span = document.createElement("span");
    span.textContent = Number(value.toFixed(1));
    return span;
  }));
  $("valid-time").textContent = state.run && state.lead !== null ? formatTime(new Date(cycleDate(state.run).getTime() + state.lead * 3600000)) : "—";
  $("map-details").textContent = state.lead !== null ? leadLabel(state.lead) + (shadingField() === "z500_anom" ? " · NOAA PSL 1991–2020 daily normal" : " · latitude / longitude") : "";
}

async function drawField() {
  fieldRequest?.abort();
  const controller = new AbortController();
  const {signal} = controller;
  fieldRequest = controller;
  drawHeader();
  drawTimeline();
  map.setWindOverlay(null);
  map.setHeightOverlay(null);
  map.setField(null);
  if (!state.run || state.lead === null) {
    setMessage(state.catalog?.models?.length ? "This run has no compiled forecast leads yet." : "Waiting for forecasts. Start the ingestion worker to populate the catalog.");
    return;
  }
  const field = shadingField();
  const product = state.product;
  let grid;
  try {
    setMessage("Loading " + leadLabel(state.lead) + " forecast…");
    grid = await getFrame(field, product, signal);
    if (signal.aborted) return;
    map.setField(grid, scaleFor(field, product));
    setMessage(null);
  } catch (error) {
    if (signal.aborted) return;
    map.setField(null);
    setMessage("Forecast unavailable. " + error.message);
    return;
  }
  try {
    if (hasHeightOverlay()) {
      const height = await getFrame("z500", product, signal);
      if (!signal.aborted) map.setHeightOverlay(height);
    } else if (state.showBarbs && windDirectionField()) {
      const windProduct = barbProduct();
      const [speed, direction] = await Promise.all([
        product === windProduct ? grid : getFrame(field, windProduct, signal),
        getFrame(windDirectionField(), windProduct, signal),
      ]);
      if (!signal.aborted) map.setWindOverlay({speed, direction});
    }
  } catch (error) {
    if (!signal.aborted) {
      $("overlay-legend").textContent = "Overlay unavailable. " + error.message;
      $("overlay-legend").hidden = false;
    }
  }
}

async function drawPoint() {
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
  try {
    const data = await getJSON("/api/point?" + pointParams(field, product, point), controller.signal);
    if (controller.signal.aborted) return;
    const scale = scaleFor(field, product);
    $("probe-label").textContent = scale.label;
    $("probe-value").textContent = data.value === null ? "Missing" : scale.convert(data.value).toFixed(field === "z500" ? 0 : 1) + " " + scale.unit;
    $("probe-coordinates").textContent = data.latitude.toFixed(2) + "°, " + data.longitude.toFixed(2) + "° · grid point";
    $("probe-result").hidden = false;
    $("probe-hint").hidden = true;
    map.setPoint({lat: data.latitude, lon: data.longitude});
  } catch (error) {
    if (!controller.signal.aborted) $("probe-hint").textContent = "Point unavailable. " + error.message;
    return;
  }
  const height = hasHeightOverlay();
  const extraField = height ? "z500" : windDirectionField();
  if (!extraField) return;
  try {
    const extraProduct = height ? product : barbProduct();
    const {value} = await getJSON("/api/point?" + pointParams(extraField, extraProduct, point), controller.signal);
    if (controller.signal.aborted || value === null) return;
    const label = height ? "Height " : extraProduct === "mean" ? "Mean direction " : "Direction ";
    $("probe-overlay").textContent = label + (height ? value.toFixed(0) + " m" : Math.round(value) % 360 + "° from");
    $("probe-overlay").hidden = false;
  } catch (error) {
    if (!controller.signal.aborted) {
      $("probe-overlay").textContent = "Overlay value unavailable";
      $("probe-overlay").hidden = false;
    }
  }
}

function selectPoint(point) {
  state.point = point;
  map.setPoint(point);
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
    if (manual) frames.clear();
    if (manual || previous !== current || !data.models?.length) refreshSelection();
    else {
      drawControls();
      drawTimeline();
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

async function changeLead(lead, pause = true) {
  if (!usableLeads().includes(lead)) return;
  if (pause) setPlayback(false);
  state.lead = lead;
  await Promise.all([drawField(), drawPoint()]);
}

function stepLead(offset) {
  const leads = usableLeads();
  const next = leads[leads.indexOf(state.lead) + offset];
  if (next !== undefined) changeLead(next);
}

function play() {
  setPlayback(!playing);
  if (!playing) return;
  const token = playToken;
  const tick = async () => {
    if (!playing || token !== playToken) return;
    const leads = usableLeads();
    if (leads.length < 2) {
      setPlayback(false);
      return;
    }
    await changeLead(leads[(leads.indexOf(state.lead) + 1) % leads.length], false);
    if (playing && token === playToken) playTimer = setTimeout(tick, 700);
  };
  tick();
}

function resetDomain() {
  map.setDomain(state.domain, state.catalog?.bounds);
  $("map-tag").textContent = $("region").selectedOptions[0].text.toUpperCase() + " · LAT / LON";
}

$("model").addEventListener("change", () => {
  setPlayback(false);
  state.model = $("model").value;
  selectDefaults(true);
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
    map.setBarbStyle(Number($("barb-size").value), Number($("barb-spacing").value));
  });
}
$("region").addEventListener("change", () => { state.domain = $("region").value; resetDomain(); });
$("reset-map").addEventListener("click", resetDomain);
$("zoom-in").addEventListener("click", () => map.zoom(.72));
$("zoom-out").addEventListener("click", () => map.zoom(1.39));
$("clear-point").addEventListener("click", () => selectPoint(null));
$("prev-lead").addEventListener("click", () => stepLead(-1));
$("next-lead").addEventListener("click", () => stepLead(1));
$("play").addEventListener("click", play);
$("refresh-catalog").addEventListener("click", () => refreshCatalog(true));

getJSON("/viewer/boundaries.json").then(layers => map.setBoundaries(layers)).catch(() => {
  document.querySelector(".attribution").textContent = "Map boundaries unavailable";
});
resetDomain();
refreshCatalog();
setInterval(() => refreshCatalog(), 60000);
