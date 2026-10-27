import * as maplibregl from 'maplibre-gl';
import { GeoJSONSource, Map as MlMap, Marker } from 'maplibre-gl';
// MapLibre 6 looks for its worker next to its own script, which doesn't exist after bundling. Ship it explicitly.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
maplibregl.setWorkerUrl(maplibreWorkerUrl);
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { DEFAULT_INPUT, Plan, PlanError, PlanInput, buildPlan } from './core/plan';
import { LngLat, centroid } from './core/projection';
import { defaultHome, edgeMidpoints, polygonAreaM2, squareAround, translate } from './core/shapes';
import { KV, PlanDoc, PlanStore, uniqueName } from './core/store';
import { areaProblem, parsePlansFile, serializePlans } from './core/planfile';
import { TERRAIN_ZOOM, Terrain, TileTerrain, tilesFor } from './core/terrain';
import { hasTiles, loadTiles, loadedTiles } from './terrainLoader';
import { makeProjection } from './core/projection';
import { missionWaypoints, toLitchiCsv } from './core/litchi';
import { polygonFromGeoJson, polygonFromKml, toKml } from './core/kml';
import { displayGeometry } from './core/display';

registerSW({ immediate: true });

// ---------- State ----------
type Settings = Omit<PlanInput, 'polygon' | 'home'>;
interface State {
  id: string;
  name: string;
  polygon: LngLat[];
  home: LngLat | null;
  settings: Settings;
  step: number;
  basemap: 'map' | 'satellite';
  view: 'steps' | 'plans';
}

const UI_KEY = 'dronecraft:ui:v1';
const LEGACY_KEY = 'dronecraft:v2';
const DEFAULT_SQUARE_M = 200;
const BUKIT_LAWANG: LngLat = [98.12, 3.55];
const MISSION_COLORS = ['#d9f99d', '#67e8f9', '#f9a8d4', '#fdba74', '#c4b5fd', '#86efac', '#fde047'];

function safeStorage(): KV {
  try {
    const k = '__dc_test__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  }
}
const kv = safeStorage();
const store = new PlanStore<Settings>(kv);

// One-time import of the single plan saved by earlier versions.
if (!store.list().length) {
  try {
    const legacy = JSON.parse(kv.getItem(LEGACY_KEY) ?? 'null');
    if (legacy?.polygon?.length >= 3) {
      store.create({ name: legacy.name && legacy.name !== 'site' ? legacy.name : 'Plan', polygon: legacy.polygon, home: legacy.home ?? null, settings: { ...DEFAULT_INPUT, ...legacy.settings } });
    }
  } catch {
    /* ignore */
  }
}

function load(): State {
  let ui: Partial<Pick<State, 'step' | 'basemap'>> = {};
  try {
    ui = JSON.parse(kv.getItem(UI_KEY) ?? '{}');
  } catch {
    /* ignore */
  }
  const doc = store.current() ?? store.create({ name: 'Plan', polygon: [], home: null, settings: { ...DEFAULT_INPUT } });
  return {
    id: doc.id,
    name: doc.name,
    polygon: doc.polygon,
    home: doc.home,
    settings: { ...DEFAULT_INPUT, ...doc.settings },
    step: ui.step ?? 0,
    basemap: ui.basemap ?? 'map',
    view: 'steps',
  };
}
const state = load();
function save() {
  store.save({ id: state.id, name: state.name, polygon: state.polygon, home: state.home, settings: state.settings, updatedAt: 0 });
  try {
    kv.setItem(UI_KEY, JSON.stringify({ step: state.step, basemap: state.basemap }));
  } catch {
    /* ignore */
  }
}

/** Load a stored plan into the editor. */
function applyDoc(doc: PlanDoc<Settings>) {
  state.id = doc.id;
  state.name = doc.name;
  state.polygon = structuredClone(doc.polygon);
  state.home = doc.home ? [...doc.home] : null;
  state.settings = { ...DEFAULT_INPUT, ...doc.settings };
}

let plan: Plan | null = null;
// ---------- Terrain ----------
let terrain: Terrain | null = null;
let terrainState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
let terrainError = '';
let terrainTimer: ReturnType<typeof setTimeout> | undefined;

/** Points whose surroundings need elevation: the area, takeoff, and a margin for edge buffers and turns. */
function terrainPoints(): LngLat[] {
  if (state.polygon.length < 3) return [];
  const pts = [...state.polygon, ...(state.home ? [state.home] : [])];
  const p = makeProjection(pts[0]);
  const local = pts.map((q) => p.toLocal(q));
  const m = 200 + state.settings.bufferM;
  const xs = local.map((q) => q[0]);
  const ys = local.map((q) => q[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs) - m, Math.max(...xs) + m, Math.min(...ys) - m, Math.max(...ys) + m];
  return [p.toLngLat([x0, y0]), p.toLngLat([x1, y1]), p.toLngLat([x0, y1]), p.toLngLat([x1, y0])];
}

/** Tile set that last failed to load, so edits elsewhere don't re-trigger it in a loop. */
let failedKeys: string | null = null;
let retryCount = 0;
const RETRY_DELAYS_S = [5, 20, 60];
const keysId = () => tilesFor(terrainPoints(), TERRAIN_ZOOM).map((k) => `${k.z}/${k.x}/${k.y}`).join(',');

/** Retry from scratch: used by the Retry button and when the connection comes back. */
function retryTerrain() {
  failedKeys = null;
  retryCount = 0;
  ensureTerrain(true);
}

/** Make sure elevation tiles for the current area are loaded; re-plan when they arrive. */
function ensureTerrain(now = false) {
  clearTimeout(terrainTimer);
  const run = async () => {
    const keys = tilesFor(terrainPoints(), TERRAIN_ZOOM);
    if (!keys.length) return;
    const id = keysId();
    if (hasTiles(keys)) {
      if (terrainState !== 'ready' || !terrain) {
        terrain = new TileTerrain(loadedTiles(), TERRAIN_ZOOM);
        terrainState = 'ready';
        update();
      }
      return;
    }
    terrainState = 'loading';
    render();
    try {
      await loadTiles(keys);
      terrain = new TileTerrain(loadedTiles(), TERRAIN_ZOOM);
      terrainState = 'ready';
      terrainError = '';
      failedKeys = null;
      retryCount = 0;
    } catch (e) {
      terrainState = 'error';
      failedKeys = id;
      const offline = navigator.onLine === false;
      terrainError = offline ? 'You are offline and this area has not been loaded before.' : (e as Error).message;
      // Transient failures get a few spaced retries; offline waits for the 'online' event or the Retry button.
      if (!offline && retryCount < RETRY_DELAYS_S.length) {
        const delay = RETRY_DELAYS_S[retryCount++] * 1000;
        clearTimeout(terrainTimer);
        terrainTimer = setTimeout(() => {
          failedKeys = null;
          ensureTerrain(true);
        }, delay);
      }
    }
    update();
  };
  if (now) void run();
  else terrainTimer = setTimeout(run, 500);
}

let planError = '';
/** Identifies the area and takeoff point; a flat-ground confirmation only counts for the area it was given for. */
function areaKey(): string {
  return JSON.stringify([state.polygon.map((p) => p.map((v) => +v.toFixed(5))), state.home?.map((v) => +v.toFixed(5))]);
}

function recompute() {
  planError = '';
  plan = null;
  if (state.polygon.length < 3 || !state.home) return;
  try {
    const flat = state.settings.flatGroundConfirmed && state.settings.flatConfirmedFor === areaKey();
    plan = buildPlan({ ...state.settings, flatGroundConfirmed: flat, polygon: state.polygon, home: state.home }, terrain);
  } catch (e) {
    planError = e instanceof PlanError ? e.message : `Planning failed: ${(e as Error).message}`;
    console.error('[dronecraft] planning failed', e);
  }
}

// ---------- Map ----------
const OSM = {
  type: 'raster' as const,
  tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
  tileSize: 256,
  maxzoom: 19,
  attribution: '© OpenStreetMap contributors',
};
const SAT = {
  type: 'raster' as const,
  tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
  tileSize: 256,
  maxzoom: 19,
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
};

const map = new MlMap({
  container: 'map',
  style: {
    version: 8,
    sources: { osm: OSM, sat: SAT },
    layers: [
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: state.basemap === 'map' ? 'visible' : 'none' } },
      { id: 'sat', type: 'raster', source: 'sat', layout: { visibility: state.basemap === 'satellite' ? 'visible' : 'none' } },
    ],
  },
  center: state.polygon[0] ?? BUKIT_LAWANG,
  zoom: 16,
  attributionControl: { compact: true, customAttribution: 'Elevation: Mapzen terrain tiles, SRTM courtesy of the U.S. Geological Survey' },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
map.addControl(
  new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: false }),
  'top-right',
);

const modeLabel = document.createElement('div');
modeLabel.className = 'mapmode';
document.getElementById('map')!.appendChild(modeLabel);

const empty = { type: 'FeatureCollection' as const, features: [] };
let overlaysReady = false;
/** Add overlay sources and layers once the style is ready. Runs once, whichever event comes first. */
function setupOverlays() {
  if (overlaysReady) return;
  overlaysReady = true;
  try {
    addOverlays();
  } catch (e) {
    console.error('[dronecraft] overlay setup failed', e);
  }
  if (state.polygon.length < 3) newSquare(false);
  else fitArea();
  refreshMarkers();
  refreshMap();
  render();
  ensureTerrain(true);
}
map.on('style.load', setupOverlays);
map.on('load', setupOverlays);
map.on('error', (e) => console.error('[dronecraft] map error', e.error?.message ?? e));

function addOverlays() {
  for (const id of ['area', 'lines', 'turns', 'transit', 'arrows', 'photos']) {
    map.addSource(id, { type: 'geojson', data: empty });
  }
  map.addLayer({ id: 'area-fill', type: 'fill', source: 'area', paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.1 } });
  map.addLayer({
    id: 'area-line',
    type: 'line',
    source: 'area',
    paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-opacity': 0.9 },
  });
  map.addLayer({
    id: 'transit',
    type: 'line',
    source: 'transit',
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [1.5, 2], 'line-opacity': 0.85 },
  });
  map.addLayer({
    id: 'turns',
    type: 'line',
    source: 'turns',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.7 },
  });
  // Dark casing under the mapping lines keeps them readable on satellite imagery.
  map.addLayer({
    id: 'lines-casing',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': '#0b120e', 'line-width': 5.5, 'line-opacity': 0.6 },
  });
  map.addLayer({
    id: 'lines',
    type: 'line',
    source: 'lines',
    layout: { 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': 3 },
  });
  map.addLayer({
    id: 'photos',
    type: 'circle',
    source: 'photos',
    minzoom: 15,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.5, 19, 4],
      'circle-color': '#ffffff',
      'circle-stroke-color': '#0b120e',
      'circle-stroke-width': 0.8,
      'circle-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'arrows',
    type: 'line',
    source: 'arrows',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#0b120e', 'line-width': 2 },
  });
}

// Tapping the map only sets takeoff, and only on the takeoff step. The area is edited with handles.
map.on('click', (e) => {
  if (state.step !== 1) return;
  state.home = [e.lngLat.lng, e.lngLat.lat];
  update();
});

/** Replace the area with a default square in the middle of the current view. */
function newSquare(keepHome: boolean) {
  const c = map.getCenter();
  state.polygon = squareAround([c.lng, c.lat], DEFAULT_SQUARE_M);
  if (!keepHome || !state.home) state.home = defaultHome(state.polygon);
  recompute();
  save();
  fitArea();
}

let vertexMarkers: Marker[] = [];
let midMarkers: Marker[] = [];
let centreMarker: Marker | null = null;
let homeMarker: Marker | null = null;

/** Move the edge and centre handles to follow the current polygon without rebuilding them. */
function positionHandles() {
  const mids = edgeMidpoints(state.polygon);
  midMarkers.forEach((m, i) => mids[i] && m.setLngLat(mids[i]));
  centreMarker?.setLngLat(centroid(state.polygon));
}

/** Live redraw during a drag, without touching the panel. */
function dragRedraw() {
  recompute();
  positionHandles();
  refreshMap();
  renderStats();
}

/** Run after the current event finishes, so a marker is never removed while MapLibre is handling it. */
function later(fn: () => void) {
  setTimeout(fn, 0);
}

function handle(cls: string, text = '', title = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  el.title = title;
  return el;
}

function refreshMarkers() {
  [...vertexMarkers, ...midMarkers].forEach((m) => m.remove());
  vertexMarkers = [];
  midMarkers = [];
  centreMarker?.remove();
  centreMarker = null;

  if (state.step === 0 && state.polygon.length >= 3) {
    // Corners: drag to move, double-tap to delete.
    state.polygon.forEach((p, i) => {
      const el = handle('vertex', '', 'Drag to move. Double-tap to delete.');
      const mk = new Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
      mk.on('drag', () => {
        const ll = mk.getLngLat();
        state.polygon[i] = [ll.lng, ll.lat];
        dragRedraw();
      });
      mk.on('dragend', () => later(update));
      // Own double-tap detection: iOS Safari does not fire dblclick reliably.
      let lastTap = 0;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const now = Date.now();
        if (now - lastTap < 400 && state.polygon.length > 3) {
          state.polygon.splice(i, 1);
          later(update);
        }
        lastTap = now;
      });
      vertexMarkers.push(mk);
    });

    // Edge "+" handles: tap or drag to insert a corner on that edge.
    edgeMidpoints(state.polygon).forEach((p, i) => {
      const el = handle('midpoint', '+', 'Tap or drag to add a corner');
      const mk = new Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
      let inserted = false;
      mk.on('dragstart', () => {
        state.polygon.splice(i + 1, 0, [mk.getLngLat().lng, mk.getLngLat().lat]);
        inserted = true;
        el.className = 'vertex';
        el.textContent = '';
      });
      mk.on('drag', () => {
        if (!inserted) return;
        const ll = mk.getLngLat();
        state.polygon[i + 1] = [ll.lng, ll.lat];
        recompute();
        refreshMap();
        renderStats();
      });
      mk.on('dragend', () => later(update));
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (inserted) return;
        inserted = true;
        state.polygon.splice(i + 1, 0, p);
        later(update);
      });
      midMarkers.push(mk);
    });

    // Centre handle: drag to move the whole area.
    const el = handle('centre', '✥', 'Drag to move the whole area');
    centreMarker = new Marker({ element: el, draggable: true }).setLngLat(centroid(state.polygon)).addTo(map);
    let last: LngLat = centroid(state.polygon);
    centreMarker.on('dragstart', () => (last = centroid(state.polygon)));
    centreMarker.on('drag', () => {
      const ll = centreMarker!.getLngLat();
      state.polygon = translate(state.polygon, ll.lng - last[0], ll.lat - last[1]);
      last = [ll.lng, ll.lat];
      vertexMarkers.forEach((m, i) => m.setLngLat(state.polygon[i]));
      dragRedraw();
    });
    centreMarker.on('dragend', () => later(update));
  }

  if (state.home) {
    if (!homeMarker) {
      homeMarker = new Marker({ element: handle('home-pin', 'H', 'Takeoff. Drag to move.'), draggable: true })
        .setLngLat(state.home)
        .addTo(map);
      homeMarker.on('drag', () => {
        const ll = homeMarker!.getLngLat();
        state.home = [ll.lng, ll.lat];
        dragRedraw();
      });
      homeMarker.on('dragend', () => later(update));
    } else homeMarker.setLngLat(state.home);
  } else if (homeMarker) {
    homeMarker.remove();
    homeMarker = null;
  }
}

let startMarkers: Marker[] = [];
let steepMarker: Marker | null = null;

function setData(id: string, data: any) {
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
}

function refreshMap() {
  // Only wait for our own sources. isStyleLoaded() is false while tiles load, which used to skip drawing.
  if (!map.getSource('area')) return;
  const ring = state.polygon;
  const areaFeature =
    ring.length >= 3
      ? { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, properties: {} }
      : ring.length === 2
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: {} }
        : null;
  (map.getSource('area') as GeoJSONSource).setData({ type: 'FeatureCollection', features: areaFeature ? [areaFeature] : [] } as any);

  startMarkers.forEach((m) => m.remove());
  startMarkers = [];
  // Before a takeoff point is set, preview the grid from the area's centre so lines show while drawing.
  const shown = plan ?? previewPlan();
  if (!shown) {
    for (const id of ['lines', 'turns', 'transit', 'arrows', 'photos']) setData(id, empty);
    return;
  }
  const home = state.home ?? shown.input.home;
  const g = displayGeometry(shown, home, MISSION_COLORS);
  setData('lines', g.lines);
  setData('turns', g.turns);
  setData('arrows', g.arrows);
  setData('photos', g.photos);
  setData('transit', state.home ? g.transit : empty);
  steepMarker?.remove();
  steepMarker = null;
  const t = plan?.terrain;
  if (t && t.maxSlope > 1) {
    const el = document.createElement('div');
    el.className = 'steep-pin';
    el.textContent = '!';
    el.title = `Steepest ground: ${Math.round(t.maxSlope * 100)}% slope. Likely cliff or rock formation.`;
    steepMarker = new Marker({ element: el }).setLngLat(t.maxSlopeAt).addTo(map);
  }
  if (state.home) {
    for (const s of g.starts) {
      const el = document.createElement('div');
      el.className = 'start-pin';
      el.style.background = s.color;
      el.textContent = String(s.mission);
      el.title = `Mission ${s.mission} starts here`;
      startMarkers.push(new Marker({ element: el }).setLngLat(s.at).addTo(map));
    }
  }
}

function previewPlan(): Plan | null {
  if (state.polygon.length < 3) return null;
  const c = state.polygon.reduce<LngLat>((a, p) => [a[0] + p[0] / state.polygon.length, a[1] + p[1] / state.polygon.length], [0, 0]);
  try {
    return buildPlan({ ...state.settings, polygon: state.polygon, home: c }, terrain);
  } catch {
    return null;
  }
}

function fitArea() {
  if (state.polygon.length < 2) return;
  const b = new maplibregl.LngLatBounds();
  state.polygon.forEach((p) => b.extend(p));
  if (state.home) b.extend(state.home);
  map.fitBounds(b, { padding: 40, maxZoom: 17, duration: 0 });
}

function setBasemap(b: State['basemap']) {
  state.basemap = b;
  map.setLayoutProperty('osm', 'visibility', b === 'map' ? 'visible' : 'none');
  map.setLayoutProperty('sat', 'visibility', b === 'satellite' ? 'visible' : 'none');
  save();
  renderStep();
}

// ---------- Panel ----------
const STEPS = ['Area', 'Takeoff', 'Settings', 'Review', 'Export'];
const $steps = document.getElementById('steps')!;
const $body = document.getElementById('step-body')!;
const $stats = document.getElementById('stats')!;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function worstStatus(): 'pass' | 'caution' | 'fail' | null {
  if (!plan) return null;
  if (plan.checks.some((c) => c.status === 'fail')) return 'fail';
  if (plan.checks.some((c) => c.status === 'caution')) return 'caution';
  return 'pass';
}

function renderSteps() {
  const w = worstStatus();
  $steps.innerHTML = STEPS.map((s, i) => {
    const dot = i === 3 && w ? `<span class="dot ${w}"></span>` : '';
    return `<button data-step="${i}" class="${state.step === i ? 'on' : ''}">${i + 1}. ${s}${dot}</button>`;
  }).join('');
  $steps.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      state.step = Number((b as HTMLElement).dataset.step);
      save();
      refreshMarkers();
      render();
    }),
  );
}

function renderStats() {
  if (!plan) {
    $stats.textContent = planError ? `Cannot plan: ${planError}` : state.polygon.length < 3 ? 'Draw an area to start' : 'Set a takeoff point';
    $stats.classList.toggle('error', !!planError);
    return;
  }
  $stats.classList.remove('error');
  const batt = plan.missions.length;
  $stats.textContent = `${plan.gsdCm.toFixed(1)} cm/px · ${plan.photoCount} photos · ${mmss(plan.totalTimeS)} · ${batt} ${batt === 1 ? 'battery' : 'batteries'}`;
}

function modeText() {
  if (state.step === 0) return 'Drag corners · tap + to add · drag ✥ to move';
  if (state.step === 1) return 'Tap the map to set the takeoff point';
  return '';
}

function renderStep() {
  modeLabel.textContent = modeText();
  modeLabel.style.display = modeLabel.textContent ? 'block' : 'none';
  const s = state.settings;
  switch (state.step) {
    case 0:
      $body.innerHTML = `
        <h2>Mapping area</h2>
        <p class="hint">Drag the corners to fit your area. Tap or drag a <b>+</b> on an edge to add a corner. Double-tap a corner to remove it. Drag the centre handle to move the whole area. You can also import a boundary from a KML or GeoJSON file.</p>
        <div class="row">
          <button class="btn" id="square">New square here</button>
          <label class="btn">Import KML / GeoJSON<input id="import" type="file" accept=".kml,.geojson,.json" hidden></label>
        </div>
        <div class="field"><div class="top"><label for="name">Plan name</label></div>
          <input id="name" type="text" value="${esc(state.name)}" maxlength="40" />
          <div class="help">Used for the plan list and file names. Open the plan list from the name at the top.</div></div>
        <div class="field"><div class="top"><label>Map</label>
          <div class="seg"><button data-b="map" class="${state.basemap === 'map' ? 'on' : ''}">Street</button><button data-b="satellite" class="${state.basemap === 'satellite' ? 'on' : ''}">Satellite</button></div></div>
          <div class="help">Satellite imagery needs a connection and is not stored for offline use.</div></div>
        <div class="row"><button class="btn primary" id="next" ${state.polygon.length >= 3 ? '' : 'disabled'}>Next: takeoff</button></div>`;
      on('square', () => {
        newSquare(true);
        update();
      });
      ($body.querySelector('#import') as HTMLInputElement).addEventListener('change', importFile);
      ($body.querySelector('#name') as HTMLInputElement).addEventListener('input', (e) => {
        state.name = (e.target as HTMLInputElement).value;
        $planName.textContent = state.name || 'Untitled';
        save();
      });
      $body.querySelectorAll('.seg button[data-b]').forEach((b) =>
        b.addEventListener('click', () => setBasemap((b as HTMLElement).dataset.b as State['basemap'])),
      );
      on('next', () => goto(1));
      break;

    case 1:
      $body.innerHTML = `
        <h2>Takeoff point</h2>
        <p class="hint">Drag the H marker or tap the map where you will launch, or use your current position. Pick a clearing with open sky and line of sight to the far end of the area. Litchi altitudes are measured from this point, so launch where you planned.</p>
        <div class="row">
          <button class="btn" id="gps">Use my position</button>
          <button class="btn" id="fit" ${state.polygon.length >= 2 ? '' : 'disabled'}>Zoom to area</button>
        </div>
        ${state.home ? `<p class="hint">Takeoff at ${state.home[1].toFixed(6)}, ${state.home[0].toFixed(6)}. Drag the H marker to move it.</p>` : ''}
        <div class="row"><button class="btn primary" id="next" ${state.home ? '' : 'disabled'}>Next: settings</button></div>`;
      on('gps', useGps);
      on('fit', fitArea);
      on('next', () => goto(2));
      break;

    case 2:
      $body.innerHTML = `
        <h2>Flight settings</h2>
        <p class="hint">Defaults suit forest canopy. Numbers in the bar above update as you change things.</p>
        ${slider('altitudeM', 'Height above trees', 30, 120, 1, 'm', 'Height above the treetops. Sets photo resolution, overlap and clearance. With elevation loaded the drone follows the terrain to hold this height. 80 to 100 m is a sensible start over tall canopy.')}
        ${slider('canopyM', 'Tree height', 0, 70, 1, 'm', 'Added to ground elevation to estimate the treetops. Use the tallest trees, not the average. Lowland Sumatran forest has emergents of 50 to 60 m. Set 0 for open ground.')}
        ${slider('minClearanceM', 'Minimum clearance', 10, 60, 1, 'm', 'Smallest allowed gap between the drone and the estimated treetops anywhere on the path. The Air 2S cannot sense obstacles to the side, so keep a margin for trees taller than you allowed for.')}
        ${slider('formationM', 'Rock formation height', 0, 300, 5, 'm', 'How far the tallest rock tower or cliff rises above the ground around it. Added to the elevation data everywhere, so the drone still follows the terrain but stays clear of formations the data cannot see (anything narrower than about 60 m). Measure it: hover level with the base of the tallest formation, climb until level with its top, and take the difference in DJI Fly altitude. 0 = not set.')}
        ${slider('obstacleFloorM', 'Highest obstacle above takeoff', 0, 400, 5, 'm', 'The tallest rock formation or tree top in or near the area, in metres above your takeoff point. Required where the app detects cliffs or rock towers, because the elevation data cannot see formations narrower than about 60 m. Measure it: climb straight up over takeoff until you are clearly above the tallest top and read the altitude in DJI Fly. 0 = not set.')}
        ${slider('frontOverlap', 'Front overlap', 0.6, 0.9, 0.01, '%', 'How much each photo overlaps the next along a line. 80% suits forest, where leaves move and texture repeats.')}
        ${slider('sideOverlap', 'Side overlap', 0.6, 0.9, 0.01, '%', 'How much neighbouring lines overlap. Sets line spacing exactly. 80% for forest.')}
        ${slider('speedMs', 'Speed', 2, 12, 0.5, 'm/s', 'Ground speed on mapping lines. Slower is smoother and gives sharper photos. The Air 2S needs at least 2 s between photos, so too fast turns the interval check red.')}
        <div class="field"><div class="top"><label>Photo trigger</label>
          <div class="seg"><button data-trig="distance" class="${s.trigger === 'distance' ? 'on' : ''}">Distance</button><button data-trig="time" class="${s.trigger === 'time' ? 'on' : ''}">Time</button></div></div>
          <div class="help">Distance takes a photo every ${plan ? plan.photoSpacingM.toFixed(1) : '…'} m, so overlap holds in wind. Time takes one every ${plan ? plan.photoIntervalS.toFixed(1) : '…'} s and overlap drifts with ground speed. Confirm distance triggering works on your Air 2S in a test flight.</div></div>
        <div class="field"><div class="top"><label for="angle">Line direction</label>
          <span><label class="checkbox" style="display:inline-flex;padding:0"><input type="checkbox" id="autoangle" ${s.gridAngleDeg === 'auto' ? 'checked' : ''}> Auto</label>
          <input type="number" id="angle" min="0" max="179" step="1" value="${plan ? Math.round(plan.angleDeg) : 0}" ${s.gridAngleDeg === 'auto' ? 'disabled' : ''}></span></div>
          <div class="help">Degrees from east, counter-clockwise. Auto follows the longest edge, which gives the fewest turns. In steady wind, lines across the wind give more even photo spacing.</div></div>
        ${slider('bufferM', 'Edge buffer', 0, 50, 1, 'm', 'Extends each line past the area edge so the edges get full overlap.')}
        <h2 style="margin-top:16px">Limits</h2>
        ${slider('batteryMin', 'Battery flight time', 15, 31, 1, 'min', 'Usable time per battery. The Air 2S is rated 31 min in still air; 27 is realistic for mapping.')}
        ${slider('reservePct', 'Battery reserve', 0.15, 0.4, 0.01, '%', 'Kept in hand for wind, the return leg and landing. 30% is a safe default in hills.')}
        ${slider('maxRangeM', 'Max distance from takeoff', 200, 3000, 50, 'm', 'Virtual stick needs the link the whole time. In hills and forest, keep this short enough for line of sight.')}
        ${slider('maxAltitudeM', 'Legal height limit', 60, 500, 10, 'm', 'Legal ceiling above the ground below the drone. 120 m in Australia and Indonesia for normal operations.')}
        ${slider('droneMaxAltM', 'DJI Fly max altitude', 20, 500, 10, 'm', 'The max altitude set in DJI Fly (Safety settings). The drone will not climb above it, even mid-mission, so it must be at least as high as the highest waypoint and the RTH altitude. Set the same in Litchi.')}
        <div class="row" style="margin-top:16px"><button class="btn" id="resetsettings">Reset settings to defaults</button></div>
        <p class="hint">Resets flight settings and limits only. The area and takeoff point stay as they are.</p>`;
      bindSliders();
      on('resetsettings', () => {
        state.settings = { ...DEFAULT_INPUT, geoZoneChecked: state.settings.geoZoneChecked };
        update();
      });
      $body.querySelectorAll('.seg button[data-trig]').forEach((b) =>
        b.addEventListener('click', () => {
          state.settings.trigger = (b as HTMLElement).dataset.trig as 'distance' | 'time';
          update();
        }),
      );
      ($body.querySelector('#autoangle') as HTMLInputElement).addEventListener('change', (e) => {
        state.settings.gridAngleDeg = (e.target as HTMLInputElement).checked ? 'auto' : Math.round(plan?.angleDeg ?? 0);
        update();
      });
      ($body.querySelector('#angle') as HTMLInputElement).addEventListener('change', (e) => {
        const v = Number((e.target as HTMLInputElement).value);
        if (Number.isFinite(v)) {
          state.settings.gridAngleDeg = ((v % 180) + 180) % 180;
          update();
        }
      });
      break;

    case 3: {
      if (!plan) {
        $body.innerHTML = planError
          ? `<div class="banner fail">This plan cannot be built: ${esc(planError)}</div>`
          : `<p class="hint">Draw an area and set a takeoff point first.</p>`;
        break;
      }
      const p = plan;
      $body.innerHTML = `
        <h2>Review</h2>
        ${p.exportBlocked ? `<div class="banner fail">Export is blocked until the red items are fixed.</div>` : ''}
        ${terrainBanner(p)}
        <dl class="kv">
          <dt>Ground resolution</dt><dd>${p.gsdCm.toFixed(2)} cm/px</dd>
          <dt>Photo footprint</dt><dd>${p.footprint.across.toFixed(0)} × ${p.footprint.along.toFixed(0)} m</dd>
          <dt>Line spacing</dt><dd>${p.lineSpacingM.toFixed(1)} m</dd>
          <dt>Photo spacing</dt><dd>${p.photoSpacingM.toFixed(1)} m (${p.photoIntervalS.toFixed(1)} s)</dd>
          <dt>Line direction</dt><dd>${p.angleDeg.toFixed(0)}°</dd>
          ${
            p.terrain
              ? `<dt>Takeoff elevation</dt><dd>${p.terrain.homeElevM.toFixed(0)} m</dd>
          <dt>Ground under lines</dt><dd>${p.terrain.minGroundM.toFixed(0)} to ${p.terrain.maxGroundM.toFixed(0)} m</dd>
          <dt>Clearance on lines</dt><dd>${p.minLineClearanceM.toFixed(0)} m above trees</dd>
          <dt>Clearance on climb-out</dt><dd>${p.minClearanceM.toFixed(0)} m above trees</dd>
          <dt>RTH altitude</dt><dd>at least ${p.terrain.rthAltM} m</dd>`
              : ''
          }
          <dt>Missions</dt><dd>${p.missions.length}</dd>
          <dt>Photos (approx.)</dt><dd>${p.photoCount}</dd>
          <dt>Total flight time</dt><dd>${mmss(p.totalTimeS)}</dd>
          <dt>Storage (approx.)</dt><dd>${((p.photoCount * 9) / 1024).toFixed(1)} GB</dd>
        </dl>
        <h2>Checks</h2>
        ${p.checks.map((c) => `<div class="check"><div class="dot ${c.status}"></div><b>${esc(c.label)}</b><span>${esc(c.detail)}</span></div>`).join('')}
        ${
          p.terrain
            ? ''
            : `<label class="checkbox"><input type="checkbox" id="flat" ${p.input.flatGroundConfirmed ? 'checked' : ''}>
          <span>This site is flat. Plan without elevation data, with altitudes constant above takeoff.</span></label>`
        }
        <label class="checkbox"><input type="checkbox" id="geo" ${state.settings.geoZoneChecked ? 'checked' : ''}>
          <span>I have checked this area on the <a href="https://www.dji.com/flysafe/geo-map" target="_blank" rel="noopener">DJI FlySafe GEO map</a> and have any unlock I need.</span></label>
        <div class="row"><button class="btn primary" id="next" ${p.exportBlocked ? 'disabled' : ''}>Next: export</button></div>`;
      ($body.querySelector('#flat') as HTMLInputElement | null)?.addEventListener('change', (e) => {
        state.settings.flatGroundConfirmed = (e.target as HTMLInputElement).checked;
        state.settings.flatConfirmedFor = areaKey();
        update();
      });
      ($body.querySelector('#geo') as HTMLInputElement).addEventListener('change', (e) => {
        state.settings.geoZoneChecked = (e.target as HTMLInputElement).checked;
        update();
      });
      on('next', () => goto(4));
      on('retryterrain', retryTerrain);
      break;
    }

    case 4: {
      if (!plan) {
        $body.innerHTML = planError
          ? `<div class="banner fail">This plan cannot be built: ${esc(planError)}</div>`
          : `<p class="hint">Draw an area and set a takeoff point first.</p>`;
        break;
      }
      const p = plan;
      const blocked = p.exportBlocked;
      $body.innerHTML = `
        <h2>Export</h2>
        ${blocked ? `<div class="banner fail">Fix the red items in Review before exporting.</div>` : ''}
        <p class="hint">Fly the missions in order, one battery each. Import each CSV in Litchi Mission Hub (Missions → Import), save it, and check it appears on your phone while you still have a connection.</p>
        <div class="banner caution"><b>Set these in Litchi for every mission</b> (the CSV cannot carry them):
          <ul>
            <li>Finish action: <b>Go Home</b> (RTH)</li>
            <li>Path mode: <b>Straight lines</b>. Curved turns ignores waypoint actions.</li>
            <li>Heading mode: <b>Toward next waypoint</b> (Auto)</li>
            <li>Mission photo interval, time and distance: <b>off</b>. Waypoints without photos are written as "use mission setting", so a mission interval would add photos on turns and transit.</li>
            <li>Keep altitudes relative to takeoff; do not switch on "Above ground".</li>
          </ul></div>
        <div class="banner fail"><b>Before every flight, in DJI Fly</b>:
          <ul>
            ${p.terrain ? `<li>RTH altitude at least <b>${p.terrain.rthAltM} m</b>.</li>` : ''}
            <li>Max altitude at least <b>${Math.ceil(Math.max(p.terrain?.rthAltM ?? 0, ...p.missions.flatMap((m) => m.itinerary!.map((w) => w.alt))) / 10) * 10} m</b> (and the same in Litchi). The drone will not climb past it.</li>
            <li>Signal lost action: <b>RTH</b>, not hover.</li>
            <li>If DJI Fly offers an RTH path option (Optimal / Preset), choose <b>Preset</b> so it climbs to RTH altitude before flying home.</li>
          </ul>
          <b>Takeoff</b>: launch at the planned takeoff point, never lower. Altitudes are measured from where the drone takes off; launching 10 m lower puts the whole flight 10 m closer to the rocks.<br>
          <b>Resuming after a battery swap</b>: do not start straight from the stopped waypoint, because Litchi flies a straight line to it that nothing has checked. Climb over takeoff to the RTH altitude, fly at that altitude until you are directly above the stopped waypoint, then start the mission from that waypoint.<br>
          Obstacle avoidance does not work during Litchi missions. Keep the drone in sight near rock faces.</div>
        ${p.missions
          .map(
            (m, i) => `
          <div class="mission">
            <div class="num" style="background:${MISSION_COLORS[i % MISSION_COLORS.length]}">${m.index}</div>
            <div>${m.lines.length} lines · ${m.waypointCount} waypoints</div>
            <button class="btn" data-dl="${i}" ${blocked ? 'disabled' : ''}>CSV</button>
            <div class="meta">${mmss(m.timeS)} · ${(m.totalDistanceM / 1000).toFixed(2)} km · farthest ${m.maxDistFromHomeM.toFixed(0)} m${m.splitLine ? ' · line cut' : ''}</div>
          </div>`,
          )
          .join('')}
        <div class="row">
          <button class="btn primary" id="share" ${blocked ? 'disabled' : ''}>Share all files</button>
          <button class="btn" id="kml" ${blocked ? 'disabled' : ''}>KML for Google Earth</button>
          <button class="btn" id="report">Plan report</button>
        </div>
        <p class="hint">${
          p.terrain
            ? 'The KML uses absolute altitudes from the elevation data, so Google Earth shows the path against its own terrain. Turn on 3D terrain there to inspect clearance.'
            : 'No elevation data: the KML shows paths at the planned height above whatever ground is below, which is only right on flat terrain.'
        }</p>`;
      $body.querySelectorAll('button[data-dl]').forEach((b) =>
        b.addEventListener('click', () => {
          const f = missionFile(Number((b as HTMLElement).dataset.dl));
          downloadFile(f);
        }),
      );
      on('share', shareAll);
      on('kml', () => downloadFile(kmlFile()));
      on('report', () => downloadFile(reportFile()));
      break;
    }
  }
}

function slider(key: keyof Settings, label: string, min: number, max: number, step: number, unit: string, help: string) {
  const v = state.settings[key] as number;
  const pct = unit === '%';
  return `<div class="field"><div class="top"><label for="s-${key}">${label}</label><span class="val" id="v-${key}">${fmtVal(v, unit)}</span></div>
    <input type="range" id="s-${key}" data-key="${key}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${v}" aria-label="${label}${pct ? ' percent' : ''}">
    <div class="help">${help}</div></div>`;
}
function fmtVal(v: number, unit: string) {
  return unit === '%' ? `${Math.round(v * 100)}%` : `${Number.isInteger(v) ? v : v.toFixed(1)} ${unit}`;
}
function bindSliders() {
  $body.querySelectorAll<HTMLInputElement>('input[type=range][data-key]').forEach((el) =>
    el.addEventListener('input', () => {
      const key = el.dataset.key as keyof Settings;
      (state.settings as any)[key] = Number(el.value);
      document.getElementById(`v-${key}`)!.textContent = fmtVal(Number(el.value), el.dataset.unit!);
      recompute();
      save();
      refreshMap();
      renderStats();
      renderSteps();
    }),
  );
}

function on(id: string, fn: () => void) {
  $body.querySelector(`#${id}`)?.addEventListener('click', fn);
}
function goto(step: number) {
  state.step = step;
  save();
  refreshMarkers();
  render();
}

const $planName = document.getElementById('plan-name')!;
document.getElementById('plans-btn')!.addEventListener('click', () => {
  state.view = state.view === 'plans' ? 'steps' : 'plans';
  importMsg = null;
  render();
});

const $saveWarn = document.getElementById('savewarn')!;

function render() {
  $planName.textContent = state.name || 'Untitled';
  $saveWarn.hidden = store.saved;
  $steps.style.display = state.view === 'plans' ? 'none' : '';
  renderStats();
  if (state.view === 'plans') {
    modeLabel.style.display = 'none';
    renderPlans();
    return;
  }
  renderSteps();
  renderStep();
}

let pendingDelete: string | null = null;
let importMsg: { kind: 'pass' | 'caution' | 'fail'; html: string } | null = null;

function exportPlans(plans: PlanDoc<Settings>[], base: string) {
  const f = new File([serializePlans(plans)], `${base}.json`, { type: 'application/json' });
  void shareOrDownload([f], plans.length === 1 ? `DroneCraft plan: ${plans[0].name}` : 'DroneCraft plans');
}

async function importPlans(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const { plans, skipped } = parsePlansFile(await file.text(), DEFAULT_INPUT as Settings & Record<string, unknown>);
  const taken = store.list().map((p) => p.name);
  const added: string[] = [];
  for (const p of plans) {
    const name = uniqueName(p.name, taken);
    taken.push(name);
    store.create({ ...p, name }, false);
    added.push(name);
  }
  const list = (xs: string[]) => xs.map((x) => `<li>${esc(x)}</li>`).join('');
  importMsg = {
    kind: added.length ? (skipped.length ? 'caution' : 'pass') : 'fail',
    html:
      (added.length ? `Imported ${added.length} plan${added.length === 1 ? '' : 's'}:<ul>${list(added)}</ul>` : 'Nothing imported.') +
      (skipped.length ? `Skipped:<ul>${list(skipped)}</ul>` : ''),
  };
  renderPlans();
}

function renderPlans() {
  const plans = store.list();
  const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  $body.innerHTML = `
    <h2>Flight plans</h2>
    <p class="hint">Plans are saved on this device as you work. Open one to edit it, or start a new one. Export to back them up or move them to another device.</p>
    <div class="row"><button class="btn primary" id="newplan">New plan</button><button class="btn" id="back">Back to ${esc(state.name || 'plan')}</button></div>
    <div class="row"><button class="btn" id="exportall" ${plans.length ? '' : 'disabled'}>Export all plans</button>
      <label class="btn">Import plans<input id="importplans" type="file" accept="application/json,.json" hidden></label></div>
    ${importMsg ? `<div class="banner ${importMsg.kind}">${importMsg.html}</div>` : ''}
    ${plans
      .map((p) => {
        const ha = polygonAreaM2(p.polygon) / 10000;
        const isCur = p.id === state.id;
        const confirm = pendingDelete === p.id;
        return `<div class="plan-row${isCur ? ' current' : ''}">
          <div class="plan-info"><b>${esc(p.name || 'Untitled')}</b>${isCur ? ' <span class="tag">open</span>' : ''}
            <div class="meta">${ha.toFixed(1)} ha · ${p.polygon.length} corners · ${fmtDate(p.updatedAt)}</div></div>
          <div class="plan-actions">
            ${isCur ? '' : `<button class="btn" data-open="${p.id}">Open</button>`}
            <button class="btn" data-dup="${p.id}">Duplicate</button>
            <button class="btn" data-exp="${p.id}">Export</button>
            <button class="btn ${confirm ? 'danger' : ''}" data-del="${p.id}">${confirm ? 'Tap to confirm' : 'Delete'}</button>
          </div></div>`;
      })
      .join('')}`;
  on('newplan', () => newPlan());
  on('exportall', () => {
    save();
    exportPlans(store.list(), `dronecraft-plans-${new Date().toISOString().slice(0, 10)}`);
  });
  ($body.querySelector('#importplans') as HTMLInputElement).addEventListener('change', importPlans);
  $body.querySelectorAll<HTMLElement>('[data-exp]').forEach((b) =>
    b.addEventListener('click', () => {
      save();
      const p = store.get(b.dataset.exp!);
      if (p) exportPlans([p], `${slugOf(p.name)}.dronecraft`);
    }),
  );
  on('back', () => {
    state.view = 'steps';
    render();
  });
  $body.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => b.addEventListener('click', () => openPlan(b.dataset.open!)));
  $body.querySelectorAll<HTMLElement>('[data-dup]').forEach((b) =>
    b.addEventListener('click', () => {
      save();
      const d = store.duplicate(b.dataset.dup!);
      if (d) openPlan(d.id, true, false);
    }),
  );
  $body.querySelectorAll<HTMLElement>('[data-del]').forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.del!;
      if (pendingDelete !== id) {
        pendingDelete = id;
        renderPlans();
        return;
      }
      pendingDelete = null;
      const wasCurrent = id === state.id;
      store.remove(id);
      if (wasCurrent) {
        const next = store.current();
        if (next) openPlan(next.id, true, false);
        else newPlan(false);
        return;
      }
      renderPlans();
    }),
  );
}

function openPlan(id: string, stayInList = false, saveCurrent = true) {
  if (saveCurrent && id !== state.id && store.get(state.id)) save();
  const doc = store.open(id);
  if (!doc) return;
  applyDoc(doc);
  pendingDelete = null;
  if (!stayInList) state.view = 'steps';
  update();
  fitArea();
}

/** `saveCurrent` is false when the current plan was just deleted, so it is not written back. */
function newPlan(saveCurrent = true) {
  if (saveCurrent && store.get(state.id)) save();
  const doc = store.create({
    name: uniqueName('Plan', store.list().map((p) => p.name)),
    polygon: [],
    home: null,
    settings: { ...DEFAULT_INPUT },
  });
  applyDoc(doc);
  newSquare(false);
  state.step = 0;
  state.view = 'steps';
  pendingDelete = null;
  update();
}

function update() {
  recompute();
  save();
  refreshMarkers();
  refreshMap();
  render();
  if (
    state.polygon.length >= 3 &&
    terrainState !== 'loading' &&
    !hasTiles(tilesFor(terrainPoints(), TERRAIN_ZOOM)) &&
    keysId() !== failedKeys
  ) {
    // A different area from the one that failed: start fresh.
    if (terrainState === 'error') retryCount = 0;
    ensureTerrain();
  }
}

function terrainBanner(p: Plan): string {
  if (terrainState === 'loading') return `<div class="banner caution">Loading elevation data for this area…</div>`;
  if (terrainState === 'error')
    return `<div class="banner fail">Elevation data could not be loaded: ${esc(terrainError)} <button class="btn" id="retryterrain">Retry</button></div>`;
  if (p.terrainStatus === 'incomplete')
    return `<div class="banner caution">Elevation data does not cover the whole plan yet. <button class="btn" id="retryterrain">Load</button></div>`;
  return '';
}

// ---------- Actions ----------
function useGps() {
  if (!navigator.geolocation) return alert('Location is not available on this device.');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.home = [pos.coords.longitude, pos.coords.latitude];
      map.easeTo({ center: state.home, zoom: Math.max(map.getZoom(), 15) });
      update();
    },
    (err) => alert(`Could not get your position: ${err.message}`),
    { enableHighAccuracy: true, timeout: 15000 },
  );
}

async function importFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const text = await file.text();
  let ring: LngLat[] | null = null;
  try {
    ring = file.name.toLowerCase().endsWith('.kml') ? polygonFromKml(text) : polygonFromGeoJson(text);
  } catch {
    ring = null;
  }
  if (!ring) return alert('No polygon found in that file.');
  if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  const problem = areaProblem(ring);
  if (problem) return alert(`Cannot use that boundary: ${problem}`);
  state.polygon = ring;
  if (/^Plan( \d+)?$/.test(state.name)) state.name = file.name.replace(/\.[^.]+$/, '');
  update();
  fitArea();
}

const slugOf = (name: string) => (name || 'plan').trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'plan';
const slug = () => slugOf(state.name);

function missionFile(i: number): File {
  const p = plan!;
  const m = p.missions[i];
  const s = state.settings;
  const csv = toLitchiCsv(
    missionWaypoints(m, p.proj, {
      altitudeM: s.altitudeM,
      speedMs: s.speedMs,
      gimbalPitch: s.gimbalPitch,
      trigger: s.trigger,
      photoSpacingM: p.photoSpacingM,
      photoIntervalS: p.photoIntervalS,
    }, p.homeXY),
  );
  // The rock formation height is in the name: on site, raise all waypoints in Litchi by (measured - this).
  const f = s.formationM > 0 ? `-f${s.formationM}` : '';
  return new File([csv], `${slug()}${f}-m${m.index}-of-${p.missions.length}.csv`, { type: 'text/csv' });
}
function kmlFile(): File {
  return new File([toKml(plan!, state.name)], `${slug()}.kml`, { type: 'application/vnd.google-earth.kml+xml' });
}
function reportFile(): File {
  const p = plan!;
  const s = state.settings;
  const L: string[] = [];
  L.push(`DroneCraft plan: ${state.name}`, `Generated ${new Date().toISOString()}`, '');
  L.push(`Takeoff: ${state.home![1].toFixed(6)}, ${state.home![0].toFixed(6)}`);
  L.push(
    `Rock formation height: ${s.formationM} m. If you measure taller formations on site, raise ALL waypoints in Litchi by the difference (select all, Edit, Altitude relative to "Current", +difference), and raise DJI Fly max altitude and RTH altitude by the same amount. Never lower.`,
    `Highest obstacle above takeoff: ${s.obstacleFloorM > 0 ? `${s.obstacleFloorM} m` : 'not set'}`,
  );
  L.push(`Height above trees: ${s.altitudeM} m (tree height ${s.canopyM} m, minimum clearance ${s.minClearanceM} m)`, `Overlap front/side: ${Math.round(s.frontOverlap * 100)}% / ${Math.round(s.sideOverlap * 100)}%`);
  L.push(`Speed: ${s.speedMs} m/s`, `Trigger: ${s.trigger === 'distance' ? `every ${p.photoSpacingM.toFixed(1)} m` : `every ${p.photoIntervalS.toFixed(1)} s`}`);
  L.push(`GSD: ${p.gsdCm.toFixed(2)} cm/px`, `Line spacing: ${p.lineSpacingM.toFixed(1)} m`, `Line direction: ${p.angleDeg.toFixed(0)} deg`);
  L.push(`Photos (approx): ${p.photoCount}`, `Total flight time: ${mmss(p.totalTimeS)}`);
  if (p.terrain) {
    L.push(`Elevation: ${p.terrain.source}`, `Takeoff elevation: ${p.terrain.homeElevM.toFixed(0)} m, ground under lines ${p.terrain.minGroundM.toFixed(0)} to ${p.terrain.maxGroundM.toFixed(0)} m`);
    L.push(`Lowest clearance above trees: ${p.minLineClearanceM.toFixed(0)} m on lines, ${p.minClearanceM.toFixed(0)} m overall`, `Recommended RTH altitude: ${p.terrain.rthAltM} m`);
  } else L.push('Elevation: not loaded, altitudes assume flat ground');
  L.push('');
  L.push('MISSIONS');
  p.missions.forEach((m) =>
    L.push(`  ${m.index}. ${m.waypointCount} wp, ${mmss(m.timeS)}, ${(m.totalDistanceM / 1000).toFixed(2)} km, farthest ${m.maxDistFromHomeM.toFixed(0)} m${m.splitLine ? ', line cut' : ''}`),
  );
  L.push('', 'CHECKS');
  p.checks.forEach((c) => L.push(`  [${c.status.toUpperCase()}] ${c.label}: ${c.detail}`));
  L.push('', 'PRE-FLIGHT CHECKLIST');
  [
    'DJI FlySafe GEO zone checked, unlock obtained if needed',
    'Permits in hand (aviation authority, land owner, national park)',
    'DJI Fly updated and GEO database synced while online',
    'All missions imported in Litchi and visible on the phone offline',
    'Litchi mission settings: finish action Go Home, path mode Straight lines, heading Toward next waypoint, mission photo interval off, altitudes relative to takeoff',
    'Camera: JPEG or RAW+JPEG, exposure locked, focus infinity, gimbal -90',
    `SD card has room for ${p.photoCount} photos (about ${((p.photoCount * 9) / 1024).toFixed(1)} GB)`,
    `${p.missions.length} batteries charged`,
    ...(p.terrain ? [`RTH altitude in DJI Fly set to at least ${p.terrain.rthAltM} m`] : []),
    'Launch from the planned takeoff point, never lower, GPS locked, line of sight to the far corner',
    `DJI Fly: max altitude at least ${Math.ceil(Math.max(p.terrain?.rthAltM ?? 0, ...p.missions.flatMap((m) => m.itinerary!.map((w) => w.alt))) / 10) * 10} m (same in Litchi), signal lost action RTH, RTH path Preset if offered`,
    'If a mission stops: note the waypoint, swap battery, climb over takeoff to RTH altitude, fly at that altitude to directly above the stopped waypoint, then start from that waypoint',
    'Obstacle avoidance is off during Litchi missions; keep the drone in sight near rock faces',
  ].forEach((t) => L.push(`  [ ] ${t}`));
  return new File([L.join('\n') + '\n'], `${slug()}-report.txt`, { type: 'text/plain' });
}

function downloadFile(f: File) {
  const url = URL.createObjectURL(f);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function shareAll() {
  const files = [...plan!.missions.map((_, i) => missionFile(i)), kmlFile(), reportFile()];
  await shareOrDownload(files, `DroneCraft: ${state.name}`);
}

/** Share sheet where available (iOS: Save to Files, AirDrop, Mail), otherwise plain downloads. */
async function shareOrDownload(files: File[], title: string) {
  if (navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, title });
      return;
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }
  }
  for (const f of files) downloadFile(f);
}

// Retry elevation automatically when the connection comes back.
window.addEventListener('online', () => {
  if (terrainState === 'error') retryTerrain();
});

// Exposed for automated smoke tests.
(window as any).__dronecraft = { state, getPlan: () => plan, update, store, terrainState: () => terrainState, map, overlaysReady: () => overlaysReady };

recompute();
refreshMarkers();
render();
// The style is inline, so it may already be ready; and elevation does not depend on the map at all.
if (map.isStyleLoaded()) setupOverlays();
ensureTerrain(true);
