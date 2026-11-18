import maplibregl from "../../_npm/maplibre-gl@5.24.0/ad5fb69e.js";
import * as d3 from "../../_npm/d3@7.9.2/172963d6.js";

// A free basemap with roads and place names, no key needed. Attribution is shown on the map.
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";
// The lower 48 states, used as the "home" view.
const US_BOUNDS = [[-124.8, 24.4], [-66.9, 49.4]];

// A teardrop pin with its tip at (0, 0), 22px tall, and a cross in its head.
const PIN_PATH = "M0,0 C-1.8,-4.6 -8,-8.2 -8,-14 A8,8 0 1 1 8,-14 C8,-8.2 1.8,-4.6 0,0 Z";
const CROSS_PATH = "M-1.5,-18.5 h3 v3 h3 v3 h-3 v3 h-3 v-3 h-3 v-3 h3 Z";
export const PIN_COLOR = "#E5751F"; // Virginia Tech Burnt Orange
export const pinIcon = (size = 16) =>
  `<svg width="${size * 0.75}" height="${size}" viewBox="-9 -23 18 24" aria-hidden="true"><path d="${PIN_PATH}" fill="${PIN_COLOR}" stroke="#fff" stroke-width="1.5"/><path d="${CROSS_PATH}" fill="#fff"/></svg>`;

function pinImage(color, scale) {
  const ratio = 2;
  const width = Math.ceil(20 * scale), height = Math.ceil(26 * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const c = canvas.getContext("2d");
  c.setTransform(ratio * scale, 0, 0, ratio * scale, (width / 2) * ratio, (height - 2 * scale) * ratio);
  c.shadowColor = "rgba(0,0,0,0.3)";
  c.shadowBlur = 3 * ratio;
  c.shadowOffsetY = 1 * ratio;
  c.fillStyle = color;
  c.fill(new Path2D(PIN_PATH));
  c.shadowColor = "transparent";
  c.lineWidth = 1.5;
  c.strokeStyle = "#fff";
  c.stroke(new Path2D(PIN_PATH));
  c.fillStyle = "#fff";
  c.fill(new Path2D(CROSS_PATH));
  return {image: c.getImageData(0, 0, canvas.width, canvas.height), pixelRatio: ratio};
}

const EMPTY = {type: "FeatureCollection", features: []};
const WORLD = [[-179.9, -85], [179.9, -85], [179.9, 85], [-179.9, 85], [-179.9, -85]];
const toCollection = (features) => ({
  type: "FeatureCollection",
  features: features.map((f) => ({type: "Feature", geometry: f.geometry, properties: {...f.properties, key: f.id, color: "#eeeeee"}}))
});

// Everything outside the shape, used to fade the rest of the map around the place in focus.
function maskAround(feature) {
  if (!feature) return EMPTY;
  const g = feature.geometry;
  const outers = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((polygon) => polygon[0]);
  return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [WORLD, ...outers]}};
}

// One web map for the whole visit. Views (states, counties, neighborhoods) swap the layers on it with
// setLayers(), so the camera never resets and moving between views is a smooth pan or zoom.
// The data layers sit under the roads and place names, so you can always tell where you are.
// "context" features are shown in light gray around the main ones (for example, other states'
// counties around one state's neighborhoods) and can be clicked to move there.
export function createMap({onSelect, onContext = () => {}, tooltip, pointDetails = null, height: fixedHeight = null}) {
  const frame = document.createElement("div");
  frame.className = "map-frame";
  if (fixedHeight) frame.style.height = fixedHeight;
  const holder = Object.assign(document.createElement("div"), {className: "map-holder"});
  holder.setAttribute("role", "region");
  holder.setAttribute("aria-label", "Map. The All places tab holds the same figures.");
  const tip = Object.assign(document.createElement("div"), {className: "map-tip"});
  const prompt = Object.assign(document.createElement("div"), {className: "map-prompt"});
  prompt.style.display = "none";
  const card = Object.assign(document.createElement("div"), {className: "map-card"});
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Provider details");
  card.style.display = "none";
  const crumbs = Object.assign(document.createElement("nav"), {className: "map-crumbs"});
  crumbs.setAttribute("aria-label", "Where you are");
  frame.append(holder, tip, prompt, card, crumbs);

  const map = new maplibregl.Map({
    container: holder,
    style: BASEMAP,
    bounds: US_BOUNDS,
    fitBoundsOptions: {padding: 24},
    cooperativeGestures: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxZoom: 15.5,
    attributionControl: {compact: true}
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({showCompass: false}), "top-right");
  map.addControl(new HomeControl(() => frame.flyHome()), "top-right");

  let layersState = {features: [], context: [], boundaries: null, regions: null};
  let byId = new Map();
  let contextById = new Map();
  let areaData = EMPTY;
  let state = {fill: () => "#eee", selected: null, points: [], spotlight: null};
  let ready = false;
  let pointsById = new Map();
  let activePoint = null;
  let hovered = null;
  let pending = [];

  // Add the data layers as soon as the basemap style is ready, without waiting for every map tile.
  map.once("style.load", () => {
    const layers = map.getStyle().layers;
    const roadLayer = layers.find((l) => /road|highway|tunnel|bridge|railway|aeroway/.test(l.id))?.id;
    const labelLayer = layers.find((l) => l.type === "symbol")?.id;
    for (const [name, color, scale] of [["pin", PIN_COLOR, 1], ["pin-active", "#861F41", 1.45]]) {
      const {image, pixelRatio} = pinImage(color, scale);
      map.addImage(name, image, {pixelRatio});
    }
    for (const id of ["areas", "context", "mask", "spot", "selected", "providers", "active", "boundaries", "regions", "region-labels"]) {
      map.addSource(id, {type: "geojson", data: EMPTY, ...(id === "areas" || id === "context" ? {promoteId: "key"} : {})});
    }
    // Data colors go under the roads, so the road network shows through.
    map.addLayer({id: "context-fill", type: "fill", source: "context", paint: {"fill-color": "#e4e2dc", "fill-opacity": 0.55}}, roadLayer);
    map.addLayer({id: "areas-fill", type: "fill", source: "areas", paint: {"fill-color": ["get", "color"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.78, 9, 0.6, 12, 0.48]}}, roadLayer);
    map.addLayer({id: "mask-fill", type: "fill", source: "mask", paint: {"fill-color": "#fcfcfb", "fill-opacity": 0.32}}, roadLayer);
    // Darker road edges, so the road network still reads through the data colors.
    for (const layer of layers) {
      if (layer.type !== "line" || !/highway|road|tunnel_motorway|bridge/.test(layer.id)) continue;
      if (/casing/.test(layer.id)) map.setPaintProperty(layer.id, "line-color", "#8d8a82");
      else if (/major|motorway/.test(layer.id)) map.setPaintProperty(layer.id, "line-color", "#ffffff");
    }
    map.addLayer({id: "context-line", type: "line", source: "context", paint: {"line-color": "#a19e95", "line-width": 0.6, "line-opacity": 0.7}}, labelLayer);
    map.addLayer({
      id: "areas-line", type: "line", source: "areas",
      paint: {"line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.3, 10, 1], "line-opacity": 0.8}
    }, labelLayer);
    map.addLayer({id: "boundaries", type: "line", source: "boundaries", paint: {"line-color": "#3d3c39", "line-width": 0.9, "line-opacity": 0.55}}, labelLayer);
    map.addLayer({id: "regions-casing", type: "line", source: "regions", paint: {"line-color": "#fcfcfb", "line-width": 4.5}}, labelLayer);
    map.addLayer({id: "regions-line", type: "line", source: "regions", paint: {"line-color": "#0b0b0b", "line-width": 2.2}}, labelLayer);
    map.addLayer({id: "hover-line", type: "line", source: "areas", filter: ["==", ["get", "key"], ""], paint: {"line-color": "#0b0b0b", "line-width": 1.6}}, labelLayer);
    map.addLayer({id: "context-hover", type: "line", source: "context", filter: ["==", ["get", "key"], ""], paint: {"line-color": "#52514e", "line-width": 1.4}}, labelLayer);
    // County and state names, since the basemap itself does not label them.
    map.addLayer({
      id: "areas-label", type: "symbol", source: "areas", minzoom: 3,
      filter: ["has", "label"],
      layout: {
        "text-field": ["get", "label"],
        "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10.5, 10, 14],
        "text-max-width": 7, "text-padding": 4
      },
      paint: {"text-color": "#3d3c39", "text-halo-color": "rgba(252,252,251,0.9)", "text-halo-width": 1.6}
    });
    map.addLayer({id: "spot-casing", type: "line", source: "spot", paint: {"line-color": "#fcfcfb", "line-width": 6.5}});
    map.addLayer({id: "spot-line", type: "line", source: "spot", paint: {"line-color": "#0b0b0b", "line-width": 3}});
    map.addLayer({id: "selected-casing", type: "line", source: "selected", paint: {"line-color": "#fcfcfb", "line-width": 6.5}});
    map.addLayer({id: "selected-line", type: "line", source: "selected", paint: {"line-color": PIN_COLOR, "line-width": 3.2}});
    map.addLayer({
      id: "region-labels", type: "symbol", source: "region-labels", maxzoom: 6,
      layout: {"text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 15, "text-letter-spacing": 0.12, "text-allow-overlap": true},
      paint: {"text-color": "#0b0b0b", "text-halo-color": "rgba(252,252,251,0.95)", "text-halo-width": 2.5}
    });
    map.addLayer({
      id: "providers", type: "symbol", source: "providers",
      layout: {"icon-image": "pin", "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["-", 0, ["get", "lat"]]}
    });
    map.addLayer({
      id: "active", type: "symbol", source: "active",
      layout: {"icon-image": "pin-active", "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true}
    });
    ready = true;
    applyLayers();
    apply({fill: true, spotlight: true, selected: true, points: true});
    for (const run of pending.splice(0)) run();
  });

  // Swap in a new set of shapes without touching the camera.
  function applyLayers() {
    if (!ready) return;
    const {features, context, boundaries, regions} = layersState;
    const dense = features.length > 4000;
    areaData = toCollection(features);
    // Names only for states and counties, and only where they won't crowd the map.
    for (const f of areaData.features) {
      const name = f.properties.NAME ?? f.properties.NAMELSAD;
      if (name && !dense) f.properties.label = name;
    }
    map.getSource("context").setData(toCollection(context));
    map.getSource("boundaries").setData(boundaries ? {type: "Feature", properties: {}, geometry: boundaries} : EMPTY);
    map.getSource("regions").setData(regions ? {type: "Feature", properties: {}, geometry: regions.mesh} : EMPTY);
    map.getSource("region-labels").setData(regions
      ? {type: "FeatureCollection", features: regions.labels.map((d) => ({type: "Feature", properties: {name: d.name.toUpperCase()}, geometry: {type: "Point", coordinates: d.at}}))}
      : EMPTY);
    map.setLayerZoomRange("areas-line", dense ? 8 : 0, 24);
    map.setLayerZoomRange("areas-label", features.length > 200 ? 6 : 3, 24);
    setHover(null);
    apply({fill: true, selected: true});
  }

  function apply(changed) {
    if (!ready) return;
    if (changed.fill) {
      for (const f of areaData.features) f.properties.color = state.fill(byId.get(f.properties.key));
      map.getSource("areas").setData(areaData);
    }
    if (changed.spotlight) {
      map.getSource("spot").setData(state.spotlight ?? EMPTY);
      map.getSource("mask").setData(maskAround(state.spotlight));
    }
    if (changed.selected) {
      const feature = state.selected ? byId.get(state.selected) : null;
      map.getSource("selected").setData(feature ?? EMPTY);
    }
    if (changed.points) {
      pointsById = new Map(state.points.map((p) => [p.pid, p]));
      map.getSource("providers").setData({
        type: "FeatureCollection",
        features: state.points.map((p) => ({type: "Feature", properties: {pid: p.pid, lat: p.latitude}, geometry: {type: "Point", coordinates: [p.longitude, p.latitude]}}))
      });
      if (activePoint && !pointsById.has(activePoint.pid)) closeCard();
    }
  }

  function setActive(point) {
    if (!ready) return;
    map.getSource("active").setData(point
      ? {type: "Feature", properties: {}, geometry: {type: "Point", coordinates: [point.longitude, point.latitude]}}
      : EMPTY);
  }

  function openCard(point) {
    if (!pointDetails) return;
    activePoint = point;
    const close = Object.assign(document.createElement("button"), {type: "button", className: "map-card-close", textContent: "×"});
    close.setAttribute("aria-label", "Close provider details");
    close.onclick = closeCard;
    card.replaceChildren(close, pointDetails(point));
    card.style.display = "block";
    tip.style.display = "none";
    setActive(point);
    keepPinVisible(point);
  }

  function closeCard() {
    activePoint = null;
    card.style.display = "none";
    setActive(null);
  }

  // If the card covers the pin, or the pin is off screen, slide the map so the pin sits beside the card.
  function keepPinVisible(point) {
    const {x, y} = map.project([point.longitude, point.latitude]);
    const width = holder.clientWidth, height = holder.clientHeight;
    const box = card.getBoundingClientRect(), frameBox = frame.getBoundingClientRect();
    const right = box.right - frameBox.left, top = box.top - frameBox.top, bottom = box.bottom - frameBox.top;
    const sideBySide = right < width * 0.7;
    const covered = sideBySide ? x < right + 16 && y > top - 30 && y < bottom + 30 : y > top - 30;
    const outside = x < 20 || y < 30 || x > width - 20 || y > height - 10;
    if (!covered && !outside) return;
    const offset = sideBySide ? [right / 2, 12] : [0, -(height - top / 2) / 2];
    map.easeTo({center: [point.longitude, point.latitude], offset, duration: 450});
  }

  function setHover(key, contextKey = null) {
    if (!ready) return;
    if (key !== hovered) {
      hovered = key;
      map.setFilter("hover-line", ["==", ["get", "key"], key ?? ""]);
    }
    map.setFilter("context-hover", ["==", ["get", "key"], contextKey ?? ""]);
  }

  // What is under the pointer: a provider pin first, then a data shape, then a context shape.
  function hit(point) {
    const pin = map.queryRenderedFeatures(point, {layers: ["providers"]})[0];
    if (pin) return {pin: pointsById.get(pin.properties.pid)};
    const area = map.queryRenderedFeatures(point, {layers: ["areas-fill"]})[0];
    if (area) return {feature: byId.get(area.properties.key)};
    const context = map.queryRenderedFeatures(point, {layers: ["context-fill"]})[0];
    if (context) return {context: contextById.get(context.properties.key)};
    return {};
  }

  map.on("mousemove", (event) => {
    if (!ready) return;
    const {pin, feature, context} = hit(event.point);
    map.getCanvas().style.cursor = pin || feature || context ? "pointer" : "";
    setHover(feature?.id ?? null, context?.id ?? null);
    const content = pin ? (pin === activePoint ? null : tooltip(pin, null)) : feature ? tooltip(null, feature) : context ? tooltip(null, context, true) : null;
    if (!content) { tip.style.display = "none"; return; }
    tip.replaceChildren(...content);
    tip.style.display = "block";
    const {x, y} = event.point, width = holder.clientWidth, height = holder.clientHeight;
    tip.style.left = `${Math.min(x + 14, width - tip.offsetWidth - 6)}px`;
    tip.style.top = `${y + tip.offsetHeight + 20 > height ? y - tip.offsetHeight - 10 : y + 14}px`;
  });
  map.on("mouseout", () => {
    tip.style.display = "none";
    setHover(null);
  });
  map.on("movestart", () => (tip.style.display = "none"));
  map.on("click", (event) => {
    if (!ready) return;
    const {pin, feature, context} = hit(event.point);
    if (pin && pointDetails) return openCard(pin);
    if (activePoint) closeCard();
    if (feature) onSelect(feature);
    else if (context) onContext(context);
  });
  frame.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activePoint) closeCard();
  });

  // The page may still be laying out when the map is created, so keep framing the US
  // to the map's size until someone moves the map or a place is zoomed to.
  let moved = false;
  const fitStart = () => {
    if (moved || holder.clientWidth < 50 || holder.clientHeight < 50) return;
    map.fitBounds(US_BOUNDS, {padding: 24, duration: 0});
  };
  map.on("movestart", (event) => {
    if (event.originalEvent) moved = true;
  });
  map.once("style.load", fitStart);
  const observer = new ResizeObserver(() => {
    map.resize();
    fitStart();
  });
  observer.observe(frame);

  const whenReady = (run) => (ready ? run() : pending.push(run));

  frame.setLayers = ({features = [], context = [], boundaries = null, regions = null}) => {
    layersState = {features, context, boundaries, regions};
    byId = new Map(features.map((f) => [f.id, f]));
    contextById = new Map(context.map((f) => [f.id, f]));
    applyLayers();
  };
  frame.update = (next) => {
    const changed = {};
    if ("fill" in next) changed.fill = true;
    if ("spotlight" in next && next.spotlight !== state.spotlight) changed.spotlight = true;
    if ("selected" in next && next.selected !== state.selected) changed.selected = true;
    if ("points" in next) changed.points = true;
    state = {...state, ...next};
    if (next.prompt !== undefined) {
      prompt.textContent = next.prompt ?? "";
      prompt.style.display = next.prompt ? "block" : "none";
    }
    apply(changed);
  };
  // The breadcrumb: a list of {label, onClick}; the last one is where you are now.
  frame.setCrumbs = (items) => {
    crumbs.replaceChildren(...items.flatMap((item, i) => {
      const last = i === items.length - 1;
      const node = last
        ? Object.assign(document.createElement("span"), {className: "crumb current", textContent: item.label})
        : Object.assign(document.createElement("button"), {type: "button", className: "crumb", textContent: item.label, onclick: item.onClick});
      if (last) node.setAttribute("aria-current", "location");
      return i ? [Object.assign(document.createElement("span"), {className: "crumb-sep", textContent: "›"}), node] : [node];
    }));
    crumbs.hidden = items.length < 2;
  };
  // Opens a provider's details from outside the map.
  frame.showPoint = (pid) => {
    const point = pointsById.get(pid);
    if (!point) return;
    frame.scrollIntoView({behavior: "smooth", block: "nearest"});
    openCard(point);
  };
  frame.flyHome = () => {
    moved = true;
    whenReady(() => map.fitBounds(US_BOUNDS, {padding: 24, duration: 800}));
  };
  // Frames a place (a feature, or the id of one on the map), with room around it to see the towns
  // and roads nearby, and any providers passed in. With {onlyIfNeeded: true} (used for clicks on
  // the map), the map stays put when the place is already in view at a useful size.
  frame.zoomToFeature = (feature, points = [], {onlyIfNeeded = false, padding = null} = {}) => {
    if (!feature) return;
    moved = true;
    whenReady(() => {
      if (onlyIfNeeded && fitsView(feature)) return;
      let [[w, s], [e, n]] = d3.geoBounds(feature);
      // Alaska's Aleutians cross the date line; frame the mainland instead of the whole globe.
      if (e - w > 180) [w, e] = [-179.5, -129];
      for (const p of points) {
        w = Math.min(w, p.longitude);
        e = Math.max(e, p.longitude);
        s = Math.min(s, p.latitude);
        n = Math.max(n, p.latitude);
      }
      const width = holder.clientWidth, height = holder.clientHeight;
      const pad = padding ?? (points.length ? 0.08 : 0.2);
      map.fitBounds([[w, s], [e, n]], {
        padding: {top: height * pad + 44, bottom: height * pad + 10, left: width * pad + 10, right: width * pad + 50},
        maxZoom: points.length ? 13 : 11.5, duration: 800
      });
    });
  };
  frame.zoomToSelected = (id, points = [], options = {}) => frame.zoomToFeature(byId.get(id), points, options);
  // True when the whole place is on screen and fills a fair share of it.
  function fitsView(feature) {
    const [[w, s], [e, n]] = d3.geoBounds(feature);
    const view = map.getBounds();
    const inside = w >= view.getWest() && e <= view.getEast() && s >= view.getSouth() && n <= view.getNorth();
    if (!inside) return false;
    const a = map.project([w, n]), b = map.project([e, s]);
    const share = Math.max(Math.abs(b.x - a.x) / holder.clientWidth, Math.abs(b.y - a.y) / holder.clientHeight);
    return share > 0.12;
  }
  frame.dispose = () => {
    observer.disconnect();
    map.remove();
  };
  return frame;
}

// A control that brings the whole country back into view.
class HomeControl {
  constructor(action) {
    this.action = action;
  }
  onAdd() {
    this.container = Object.assign(document.createElement("div"), {className: "maplibregl-ctrl maplibregl-ctrl-group"});
    const button = Object.assign(document.createElement("button"), {type: "button", className: "map-reset", textContent: "⌂", title: "Zoom out to the whole US"});
    button.setAttribute("aria-label", "Zoom out to the whole US");
    button.onclick = this.action;
    this.container.append(button);
    return this.container;
  }
  onRemove() {
    this.container.remove();
  }
}
