import * as d3 from "../../_npm/d3@7.9.2/172963d6.js";

// A teardrop pin with its tip at (0, 0), 22px tall, and a cross in its head.
const PIN = new Path2D("M0,0 C-1.8,-4.6 -8,-8.2 -8,-14 A8,8 0 1 1 8,-14 C8,-8.2 1.8,-4.6 0,0 Z");
const CROSS = new Path2D("M-1.5,-18.5 h3 v3 h3 v3 h-3 v3 h-3 v-3 h-3 v-3 h3 Z");
export const PIN_COLOR = "#d95926";
export const pinIcon = (size = 16) =>
  `<svg width="${size * 0.75}" height="${size}" viewBox="-9 -23 18 24" aria-hidden="true"><path d="M0,0 C-1.8,-4.6 -8,-8.2 -8,-14 A8,8 0 1 1 8,-14 C8,-8.2 1.8,-4.6 0,0 Z" fill="${PIN_COLOR}" stroke="#fff" stroke-width="1.5"/><path d="M-1.5,-18.5 h3 v3 h3 v3 h-3 v3 h-3 v-3 h-3 v-3 h3 Z" fill="#fff"/></svg>`;

// A canvas map, because a large state has over 20,000 block groups and SVG would crawl.
// Created once per geography; update() repaints without losing the pan and zoom.
// While panning or zooming it moves a saved image of the map, then redraws it sharp once you stop.
export function createMap({features, boundaries, regions = null, onSelect, tooltip, pointDetails = null, height: fixedHeight = null}) {
  const frame = document.createElement("div");
  frame.className = "map-frame";
  if (fixedHeight) frame.style.height = fixedHeight;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "Map. The table below holds the same figures.");
  const tip = Object.assign(document.createElement("div"), {className: "map-tip"});
  const prompt = Object.assign(document.createElement("div"), {className: "map-prompt"});
  prompt.style.display = "none";
  const hint = Object.assign(document.createElement("div"), {className: "map-hint", textContent: /Mac|iPhone|iPad/.test(navigator.platform) ? "Hold ⌘ and scroll to zoom" : "Hold Ctrl and scroll to zoom"});
  const card = Object.assign(document.createElement("div"), {className: "map-card"});
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "Provider details");
  card.style.display = "none";
  const buttons = Object.assign(document.createElement("div"), {className: "map-buttons"});
  frame.append(canvas, tip, prompt, hint, card, buttons);

  const context = canvas.getContext("2d");
  const base = document.createElement("canvas");
  const baseContext = base.getContext("2d");
  let baseTransform = null;
  let state = {fill: () => "#eee", selected: null, points: [], spotlight: null};
  let transform = d3.zoomIdentity;
  let width = 0, height = 0, ratio = 1, shapes = [], outline = null, regionLines = null, grid = null, projection = null, path = null;
  let spotPath = null, activePoint = null;
  let frameRequest = null, sharpTimer = null, moving = false, hintTimer = null;
  let waitingZoom = null;
  let projectedPoints = [];
  const cellSize = 40;

  function layout() {
    const box = frame.getBoundingClientRect();
    if (!box.width || !box.height) return;
    width = box.width;
    height = box.height;
    ratio = window.devicePixelRatio || 1;
    canvas.width = base.width = Math.round(width * ratio);
    canvas.height = base.height = Math.round(height * ratio);
    projection = d3.geoAlbersUsa().fitExtent([[10, 10], [width - 10, height - 10]], {type: "FeatureCollection", features});
    path = d3.geoPath(projection);
    grid = new Map();
    shapes = features.map((feature, index) => {
      const shape = new Path2D(path(feature) ?? "");
      const [[x0, y0], [x1, y1]] = path.bounds(feature);
      if (Number.isFinite(x0)) {
        for (let i = Math.floor(x0 / cellSize); i <= Math.floor(x1 / cellSize); ++i) {
          for (let j = Math.floor(y0 / cellSize); j <= Math.floor(y1 / cellSize); ++j) {
            const key = i * 100000 + j;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(index);
          }
        }
      }
      return shape;
    });
    outline = boundaries ? new Path2D(path(boundaries) ?? "") : null;
    regionLines = regions ? new Path2D(path(regions.mesh) ?? "") : null;
    projectPoints();
    projectSpotlight();
    transform = d3.zoomIdentity;
    d3.select(canvas).property("__zoom", d3.zoomIdentity);
    baseTransform = null;
    draw();
    if (waitingZoom) {
      const {id, points} = waitingZoom;
      waitingZoom = null;
      frame.zoomToSelected(id, points);
    }
  }

  function projectPoints() {
    if (!projection) return;
    // Drawn north to south, so pins further down the screen sit in front.
    projectedPoints = state.points
      .map((point) => ({point, xy: projection([point.longitude, point.latitude])}))
      .filter((d) => d.xy)
      .sort((a, b) => a.xy[1] - b.xy[1]);
  }

  function projectSpotlight() {
    spotPath = path && state.spotlight ? new Path2D(path(state.spotlight) ?? "") : null;
  }

  function draw() {
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = null;
      // A big jump in zoom would blur the saved image, so redraw it sharp partway through.
      const drift = baseTransform ? transform.k / baseTransform.k : 1;
      if (moving && baseTransform && drift < 2 && drift > 0.5) paintMoving();
      else paintSharp();
    });
  }

  // The slow layer: every shape, filled and outlined, at the current zoom.
  function paintBase() {
    const c = baseContext;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, base.width, base.height);
    c.setTransform(ratio * transform.k, 0, 0, ratio * transform.k, ratio * transform.x, ratio * transform.y);
    features.forEach((feature, index) => {
      c.fillStyle = state.fill(feature);
      c.fill(shapes[index]);
    });
    // Hairlines between shapes are dropped when zoomed out on dense maps, where they would be all you see.
    if (features.length <= 2000 || transform.k >= 2.5) {
      c.lineWidth = 0.5 / transform.k;
      c.strokeStyle = "rgba(252,252,251,0.9)";
      shapes.forEach((shape) => c.stroke(shape));
    }
    if (outline) {
      c.lineWidth = 0.8 / transform.k;
      c.strokeStyle = "rgba(11,11,11,0.38)";
      c.stroke(outline);
    }
    if (regionLines) {
      c.lineJoin = "round";
      c.lineWidth = 4 / transform.k;
      c.strokeStyle = "rgba(252,252,251,0.95)";
      c.stroke(regionLines);
      c.lineWidth = 2 / transform.k;
      c.strokeStyle = "#0b0b0b";
      c.stroke(regionLines);
    }
    baseTransform = transform;
  }

  function paintSharp() {
    paintBase();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(base, 0, 0);
    paintOverlay();
  }

  // The fast path while moving: shift and scale the saved image instead of redrawing every shape.
  function paintMoving() {
    const scale = transform.k / baseTransform.k;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#fcfcfb";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, ratio * (transform.x - scale * baseTransform.x), ratio * (transform.y - scale * baseTransform.y));
    context.imageSmoothingEnabled = true;
    context.drawImage(base, 0, 0);
    paintOverlay();
  }

  function ring(shape, inner, outer, color) {
    context.lineJoin = "round";
    context.lineWidth = outer / transform.k;
    context.strokeStyle = "#fcfcfb";
    context.stroke(shape);
    context.lineWidth = inner / transform.k;
    context.strokeStyle = color;
    context.stroke(shape);
  }

  // The quick layer, drawn sharp on every frame: the spotlight, the chosen place, region names and pins.
  function paintOverlay() {
    context.setTransform(ratio * transform.k, 0, 0, ratio * transform.k, ratio * transform.x, ratio * transform.y);
    // Fade everything outside the place in focus, so it stands out at any zoom.
    if (spotPath) {
      const veil = new Path2D();
      veil.rect(-transform.x / transform.k - 10, -transform.y / transform.k - 10, width / transform.k + 20, height / transform.k + 20);
      veil.addPath(spotPath);
      context.fillStyle = "rgba(252,252,251,0.62)";
      context.fill(veil, "evenodd");
      ring(spotPath, 2.6, 6, "#0b0b0b");
    }
    const selected = state.selected == null ? -1 : features.findIndex((f) => f.id === state.selected);
    if (selected >= 0) ring(shapes[selected], spotPath ? 3 : 2.6, 7, spotPath ? PIN_COLOR : "#0b0b0b");
    if (regions && projection) {
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.font = `750 ${width < 600 ? 11 : 15}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      if ("letterSpacing" in context) context.letterSpacing = "1.5px";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineJoin = "round";
      for (const label of regions.labels) {
        const xy = projection(label.at);
        if (!xy) continue;
        const [x, y] = transform.apply(xy);
        const text = label.name.toUpperCase();
        context.lineWidth = 4;
        context.strokeStyle = "rgba(252,252,251,0.95)";
        context.strokeText(text, x, y);
        context.fillStyle = "#0b0b0b";
        context.fillText(text, x, y);
      }
      if ("letterSpacing" in context) context.letterSpacing = "0px";
    }
    for (const {point, xy} of projectedPoints) {
      if (point === activePoint) continue;
      drawPin(xy, 1, PIN_COLOR);
    }
    const active = activePoint && projectedPoints.find((d) => d.point === activePoint);
    if (active) drawPin(active.xy, 1.45, "#0b0b0b");
  }

  function drawPin(xy, size, color) {
    const [x, y] = transform.apply(xy);
    if (x < -20 || y < -10 || x > width + 20 || y > height + 40) return;
    context.setTransform(ratio * size, 0, 0, ratio * size, ratio * x, ratio * y);
    context.shadowColor = "rgba(0,0,0,0.28)";
    context.shadowBlur = 3 * ratio;
    context.shadowOffsetY = 1 * ratio;
    context.fillStyle = color;
    context.fill(PIN);
    context.shadowColor = "transparent";
    context.lineWidth = 1.5;
    context.strokeStyle = "#ffffff";
    context.stroke(PIN);
    context.fillStyle = "#ffffff";
    context.fill(CROSS);
  }

  function featureAt(px, py) {
    if (!grid) return null;
    const x = (px - transform.x) / transform.k;
    const y = (py - transform.y) / transform.k;
    const candidates = grid.get(Math.floor(x / cellSize) * 100000 + Math.floor(y / cellSize));
    if (!candidates) return null;
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    const hit = candidates.find((index) => context.isPointInPath(shapes[index], x, y));
    context.restore();
    return hit === undefined ? null : features[hit];
  }

  // The pin's head is the target, since that is what people aim at.
  function pointAt(px, py) {
    let best = null, distance = 14 ** 2;
    for (const {point, xy} of projectedPoints) {
      const [x, y] = transform.apply(xy);
      const d = (x - px) ** 2 + (y - 13 - py) ** 2;
      if (d <= distance) { distance = d; best = point; }
    }
    return best;
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
    keepPinVisible(point);
    draw();
  }

  // If the card covers the pin, or the pin is off screen, slide the map so the pin sits beside the card.
  function keepPinVisible(point) {
    const found = projectedPoints.find((d) => d.point === point);
    if (!found) return;
    const [x, y] = transform.apply(found.xy);
    const box = card.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const right = box.right - frameBox.left, top = box.top - frameBox.top, bottom = box.bottom - frameBox.top;
    const sideBySide = right < width * 0.7;
    const covered = sideBySide ? x < right + 16 && y > top - 30 && y < bottom + 30 : y > top - 30;
    const outside = x < 20 || y < 30 || x > width - 20 || y > height - 10;
    if (!covered && !outside) return;
    const target = sideBySide ? [(right + width) / 2, height / 2 + 12] : [width / 2, Math.max(40, top / 2 + 12)];
    selection.transition().duration(400).call(zoom.translateTo, found.xy[0], found.xy[1], target);
  }

  function closeCard() {
    activePoint = null;
    card.style.display = "none";
    draw();
  }

  function showHint() {
    hint.classList.add("show");
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove("show"), 1400);
  }

  const zoom = d3.zoom()
    .scaleExtent([1, 80])
    // The wheel keeps scrolling the page unless it is a trackpad pinch or a ctrl/⌘ scroll.
    .filter((event) => {
      if (event.type === "wheel") {
        const ok = event.ctrlKey || event.metaKey;
        if (!ok) showHint();
        return ok;
      }
      return !event.button;
    })
    .wheelDelta((event) => -event.deltaY * (event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002) * (event.ctrlKey ? 5 : 1.5))
    .on("start", () => {
      moving = true;
      tip.style.display = "none";
      canvas.classList.add("dragging");
    })
    .on("zoom", (event) => {
      transform = event.transform;
      draw();
    })
    .on("end", () => {
      canvas.classList.remove("dragging");
      clearTimeout(sharpTimer);
      sharpTimer = setTimeout(() => {
        moving = false;
        draw();
      }, 120);
    });
  const selection = d3.select(canvas).call(zoom).on("dblclick.zoom", null);
  const addButton = (text, label, action) => {
    const button = Object.assign(document.createElement("button"), {textContent: text, type: "button"});
    button.setAttribute("aria-label", label);
    button.title = label;
    button.onclick = action;
    buttons.append(button);
  };
  addButton("+", "Zoom in", () => selection.transition().duration(250).call(zoom.scaleBy, 2));
  addButton("−", "Zoom out", () => selection.transition().duration(250).call(zoom.scaleBy, 0.5));
  addButton("⟲", "Reset map", () => selection.transition().duration(300).call(zoom.transform, d3.zoomIdentity));

  canvas.addEventListener("pointermove", (event) => {
    if (moving || event.buttons) return;
    const [x, y] = d3.pointer(event, canvas);
    const point = pointAt(x, y);
    const feature = point ? null : featureAt(x, y);
    canvas.style.cursor = point || feature ? "pointer" : "grab";
    const content = point ? (point === activePoint ? null : tooltip(point, null)) : feature ? tooltip(null, feature) : null;
    if (!content) { tip.style.display = "none"; return; }
    tip.replaceChildren(...content);
    tip.style.display = "block";
    tip.style.left = `${Math.min(x + 14, width - tip.offsetWidth - 6)}px`;
    tip.style.top = `${y + tip.offsetHeight + 20 > height ? y - tip.offsetHeight - 10 : y + 14}px`;
  });
  canvas.addEventListener("pointerleave", () => (tip.style.display = "none"));
  canvas.addEventListener("click", (event) => {
    if (event.defaultPrevented) return;
    const [x, y] = d3.pointer(event, canvas);
    const point = pointAt(x, y);
    if (point && pointDetails) return openCard(point);
    if (activePoint) closeCard();
    const feature = featureAt(x, y);
    if (feature) onSelect(feature);
  });
  frame.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activePoint) closeCard();
  });

  const observer = new ResizeObserver(() => {
    const box = frame.getBoundingClientRect();
    if (box.width !== width || box.height !== height) layout();
  });
  observer.observe(frame);

  frame.update = (next) => {
    state = {...state, ...next};
    if (next.points) {
      projectPoints();
      if (activePoint && !next.points.some((p) => p.pid === activePoint.pid)) closeCard();
    }
    if ("spotlight" in next) projectSpotlight();
    if (next.prompt !== undefined) {
      prompt.textContent = next.prompt ?? "";
      prompt.style.display = next.prompt ? "block" : "none";
    }
    if (width) {
      moving = false;
      draw();
    }
  };
  // Opens a provider's details from outside the map, panning so its pin is in view.
  frame.showPoint = (pid) => {
    const found = projectedPoints.find((d) => d.point.pid === pid);
    if (!found) return;
    frame.scrollIntoView({behavior: "smooth", block: "nearest"});
    openCard(found.point);
  };
  // Frames the place, along with any providers passed in so they stay on screen.
  frame.zoomToSelected = (id, points = []) => {
    const index = features.findIndex((f) => f.id === id);
    if (index < 0) return;
    if (!projection) {
      waitingZoom = {id, points};
      return;
    }
    let [[x0, y0], [x1, y1]] = path.bounds(features[index]);
    for (const point of points) {
      const xy = projection([point.longitude, point.latitude]);
      if (!xy) continue;
      x0 = Math.min(x0, xy[0]);
      y0 = Math.min(y0, xy[1]);
      x1 = Math.max(x1, xy[0]);
      y1 = Math.max(y1, xy[1]);
    }
    const fill = points.length ? 0.82 : 0.5;
    const k = Math.min(30, fill / Math.max((x1 - x0) / width, (y1 - y0) / height));
    selection.transition().duration(450).call(zoom.transform,
      d3.zoomIdentity.translate(width / 2, height / 2 + (points.length ? 8 : 0)).scale(Math.max(1, k)).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
  };
  frame.dispose = () => observer.disconnect();
  return frame;
}
