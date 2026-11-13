import maplibregl from "../../_npm/maplibre-gl@5.24.0/ad5fb69e.js";
import * as d3 from "../../_npm/d3@7.9.2/172963d6.js";

// A free basemap with roads and place names, no key needed. Attribution is shown on the map.
const BASEMAP = "https://tiles.openfreemap.org/styles/positron";

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

// Everything outside the shape, used to fade the rest of the map around the place in focus.
function maskAround(feature) {
  if (!feature) return EMPTY;
  const g = feature.geometry;
  const outers = g.type === "Polygon" ? [g.coordinates[0]] : g.coordinates.map((polygon) => polygon[0]);
  return {type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [WORLD, ...outers]}};
}

// Bounds that ignore Alaska and Hawaii when the map also has the lower 48, so the US view is not tiny.
function boundsOf(features) {
  const main = features.filter((f) => !/^(02|15)/.test(f.id));
  const use = main.length && main.length < features.length ? main : features;
  return d3.geoBounds({type: "FeatureCollection", features: use});
}

// A web map with a road basemap. The data layers sit under the roads and place names, so you can always tell where you are.
// Created once per geography; update() changes colors, focus and pins without moving the map.
export function createMap({features, boundaries, regions = null, onSelect, tooltip, pointDetails = null, height: fixedHeight = null}) {
  const frame = document.createElement("div");
  frame.className = "map-frame";
  if (fixedHeight) frame.style.height = fixedHeight;
  const holder = Object.assign(document.createElement("div"), {className: "map-holder"});
  holder.setAttribute("role", "region");
  holder.setAttribute("aria-label", "Map. The table below holds the same figures.");
  const tip = Object.assign(document.createElement("div"), {className: "map-tip"});
  const prompt = Object.assign(document.createElement("div"), {className: "map-prompt"});
  prompt.style.display = "none";
  const card = Object.assign(document.createElement("div"), {className: "map-card"});
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Provider details");
  card.style.display = "none";
  frame.append(holder, tip, prompt, card);

  const byId = new Map(features.map((f) => [f.id, f]));
  const areaData = {
    type: "FeatureCollection",
    features: features.map((f) => ({type: "Feature", geometry: f.geometry, properties: {...f.properties, key: f.id, color: "#eeeeee"}}))
  };
  const [[west, south], [east, north]] = boundsOf(features);
  const map = new maplibregl.Map({
    container: holder,
    style: BASEMAP,
    bounds: [[west, south], [east, north]],
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
  map.addControl(new ResetControl(() => map.fitBounds([[west, south], [east, north]], {padding: 24, duration: 500})), "top-right");

  let state = {fill: () => "#eee", selected: null, points: [], spotlight: null};
  let ready = false;
  let pointsById = new Map();
  let activePoint = null;
  let hovered = null;
  let waitingZoom = null;

  // Add the data layers as soon as the basemap style is ready, without waiting for every map tile.
  map.once("style.load", () => {
    const layers = map.getStyle().layers;
    const roadLayer = layers.find((l) => /road|highway|tunnel|bridge|railway|aeroway/.test(l.id))?.id;
    const labelLayer = layers.find((l) => l.type === "symbol")?.id;
    for (const [name, color, scale] of [["pin", PIN_COLOR, 1], ["pin-active", "#861F41", 1.45]]) {
      const {image, pixelRatio} = pinImage(color, scale);
      map.addImage(name, image, {pixelRatio});
    }
    map.addSource("areas", {type: "geojson", data: areaData, promoteId: "key"});
    map.addSource("mask", {type: "geojson", data: EMPTY});
    map.addSource("spot", {type: "geojson", data: EMPTY});
    map.addSource("selected", {type: "geojson", data: EMPTY});
    map.addSource("providers", {type: "geojson", data: EMPTY});
    map.addSource("active", {type: "geojson", data: EMPTY});
    // Data colors go under the roads, so the road network shows through.
    map.addLayer({id: "areas-fill", type: "fill", source: "areas", paint: {"fill-color": ["get", "color"], "fill-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.78, 9, 0.6, 12, 0.48]}}, roadLayer);
    map.addLayer({id: "mask-fill", type: "fill", source: "mask", paint: {"fill-color": "#fcfcfb", "fill-opacity": 0.5}}, roadLayer);
    // Darker road edges, so the road network still reads through the data colors.
    for (const layer of layers) {
      if (layer.type !== "line" || !/highway|road|tunnel_motorway|bridge/.test(layer.id)) continue;
      if (/casing/.test(layer.id)) map.setPaintProperty(layer.id, "line-color", "#8d8a82");
      else if (/major|motorway/.test(layer.id)) map.setPaintProperty(layer.id, "line-color", "#ffffff");
    }
    map.addLayer({
      id: "areas-line", type: "line", source: "areas",
      minzoom: features.length > 2000 ? 8 : 0,
      paint: {"line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.3, 10, 1], "line-opacity": 0.8}
    }, labelLayer);
    if (boundaries) {
      map.addSource("boundaries", {type: "geojson", data: {type: "Feature", properties: {}, geometry: boundaries}});
      map.addLayer({id: "boundaries", type: "line", source: "boundaries", paint: {"line-color": "#3d3c39", "line-width": 0.9, "line-opacity": 0.55}}, labelLayer);
    }
    if (regions) {
      map.addSource("regions", {type: "geojson", data: {type: "Feature", properties: {}, geometry: regions.mesh}});
      map.addLayer({id: "regions-casing", type: "line", source: "regions", paint: {"line-color": "#fcfcfb", "line-width": 4.5}}, labelLayer);
      map.addLayer({id: "regions-line", type: "line", source: "regions", paint: {"line-color": "#0b0b0b", "line-width": 2.2}}, labelLayer);
    }
    map.addLayer({id: "hover-line", type: "line", source: "areas", filter: ["==", ["get", "key"], ""], paint: {"line-color": "#0b0b0b", "line-width": 1.6}}, labelLayer);
    // County and state names, since the basemap itself does not label them.
    if (features.length <= 4000 && features.some((f) => f.properties.NAME || f.properties.NAMELSAD)) {
      map.addLayer({
        id: "areas-label", type: "symbol", source: "areas",
        minzoom: features.length > 200 ? 6 : 3,
        layout: {
          "text-field": ["coalesce", ["get", "NAME"], ["get", "NAMELSAD"]],
          "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 11, 10, 14],
          "text-max-width": 7, "text-padding": 4
        },
        paint: {"text-color": "#3d3c39", "text-halo-color": "rgba(252,252,251,0.9)", "text-halo-width": 1.6}
      });
    }
    map.addLayer({id: "spot-casing", type: "line", source: "spot", paint: {"line-color": "#fcfcfb", "line-width": 6.5}});
    map.addLayer({id: "spot-line", type: "line", source: "spot", paint: {"line-color": "#0b0b0b", "line-width": 3}});
    map.addLayer({id: "selected-casing", type: "line", source: "selected", paint: {"line-color": "#fcfcfb", "line-width": 6.5}});
    map.addLayer({id: "selected-line", type: "line", source: "selected", paint: {"line-color": PIN_COLOR, "line-width": 3.2}});
    if (regions) {
      map.addSource("region-labels", {
        type: "geojson",
        data: {type: "FeatureCollection", features: regions.labels.map((d) => ({type: "Feature", properties: {name: d.name.toUpperCase()}, geometry: {type: "Point", coordinates: d.at}}))}
      });
      map.addLayer({
        id: "region-labels", type: "symbol", source: "region-labels", maxzoom: 6,
        layout: {"text-field": ["get", "name"], "text-font": ["Noto Sans Bold"], "text-size": 15, "text-letter-spacing": 0.12, "text-allow-overlap": true},
        paint: {"text-color": "#0b0b0b", "text-halo-color": "rgba(252,252,251,0.95)", "text-halo-width": 2.5}
      });
    }
    map.addLayer({
      id: "providers", type: "symbol", source: "providers",
      layout: {"icon-image": "pin", "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true, "symbol-sort-key": ["-", 0, ["get", "lat"]]}
    });
    map.addLayer({
      id: "active", type: "symbol", source: "active",
      layout: {"icon-image": "pin-active", "icon-anchor": "bottom", "icon-allow-overlap": true, "icon-ignore-placement": true}
    });
    ready = true;
    apply({fill: true, spotlight: true, selected: true, points: true});
    if (waitingZoom) {
      const {id, points} = waitingZoom;
      waitingZoom = null;
      frame.zoomToSelected(id, points);
    }
  });

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

  function setHover(key) {
    if (key === hovered || !ready) return;
    hovered = key;
    map.setFilter("hover-line", ["==", ["get", "key"], key ?? ""]);
  }

  map.on("mousemove", (event) => {
    if (!ready) return;
    const pin = map.queryRenderedFeatures(event.point, {layers: ["providers"]})[0];
    const area = pin ? null : map.queryRenderedFeatures(event.point, {layers: ["areas-fill"]})[0];
    map.getCanvas().style.cursor = pin || area ? "pointer" : "";
    setHover(area?.properties.key ?? null);
    const point = pin ? pointsById.get(pin.properties.pid) : null;
    const feature = area ? byId.get(area.properties.key) : null;
    const content = point ? (point === activePoint ? null : tooltip(point, null)) : feature ? tooltip(null, feature) : null;
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
    const pin = map.queryRenderedFeatures(event.point, {layers: ["providers"]})[0];
    if (pin && pointDetails) return openCard(pointsById.get(pin.properties.pid));
    if (activePoint) closeCard();
    const area = map.queryRenderedFeatures(event.point, {layers: ["areas-fill"]})[0];
    if (area) onSelect(byId.get(area.properties.key));
  });
  frame.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activePoint) closeCard();
  });

  // The page may still be laying out when the map is created, so keep framing the area
  // to the map's size until someone moves the map or a place is zoomed to.
  let moved = false;
  const fitHome = () => {
    if (moved || waitingZoom || holder.clientWidth < 50 || holder.clientHeight < 50) return;
    map.fitBounds([[west, south], [east, north]], {padding: 24, duration: 0});
  };
  map.on("movestart", (event) => {
    if (event.originalEvent) moved = true;
  });
  map.once("style.load", fitHome);
  const observer = new ResizeObserver(() => {
    map.resize();
    fitHome();
  });
  observer.observe(frame);

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
  // Opens a provider's details from outside the map.
  frame.showPoint = (pid) => {
    const point = pointsById.get(pid);
    if (!point) return;
    frame.scrollIntoView({behavior: "smooth", block: "nearest"});
    openCard(point);
  };
  // Frames a place, with room around it to see the towns and roads nearby, and any providers passed in.
  // With {onlyIfNeeded: true} (used for clicks on the map), the map stays put when the place is
  // already in view at a useful size, so clicking around never yanks the view somewhere else.
  frame.zoomToSelected = (id, points = [], {onlyIfNeeded = false} = {}) => {
    const feature = byId.get(id);
    if (!feature) return;
    if (onlyIfNeeded && ready && fitsView(feature)) return;
    moved = true;
    if (!ready) {
      waitingZoom = {id, points};
      return;
    }
    let [[w, s], [e, n]] = d3.geoBounds(feature);
    for (const p of points) {
      w = Math.min(w, p.longitude);
      e = Math.max(e, p.longitude);
      s = Math.min(s, p.latitude);
      n = Math.max(n, p.latitude);
    }
    // Leave a margin around the place so nearby towns and roads stay in view.
    const width = holder.clientWidth, height = holder.clientHeight;
    const pad = points.length ? 0.08 : 0.2;
    map.fitBounds([[w, s], [e, n]], {
      padding: {top: height * pad + 30, bottom: height * pad + 10, left: width * pad + 10, right: width * pad + 50},
      maxZoom: points.length ? 13 : 11.5, duration: 700
    });
  };
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

class ResetControl {
  constructor(action) {
    this.action = action;
  }
  onAdd() {
    this.container = Object.assign(document.createElement("div"), {className: "maplibregl-ctrl maplibregl-ctrl-group"});
    const button = Object.assign(document.createElement("button"), {type: "button", className: "map-reset", textContent: "⟲", title: "Reset map"});
    button.setAttribute("aria-label", "Reset map");
    button.onclick = this.action;
    this.container.append(button);
    return this.container;
  }
  onRemove() {
    this.container.remove();
  }
}
