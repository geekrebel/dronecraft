# DroneCraft: Specification

A free, offline-capable web app (PWA) that plans photogrammetry grid missions for the DJI Air 2S and exports them as Litchi CSV files. Designed for forest mapping on sloped terrain in remote areas, with WebODM as the processing target.

Status legend: **[MVP]** first release, **[v1]** before the Sumatra trip, **[v2]** later.

---

## 1. Context and constraints

- The Air 2S has no onboard waypoint support. Litchi flies it by virtual stick: the phone sends live stick commands, so the mission only runs while the controller link holds.
- Litchi altitudes are relative to the takeoff point, not sea level.
- Litchi missions are limited to 99 waypoints.
- Missions reach the phone through Litchi Mission Hub, which needs internet to sync. The app can plan offline, but a new plan needs a connection to get into Litchi.
- DJI GEO zones are enforced by DJI firmware and cannot be overridden by Litchi or this app.
- Minimum photo interval on the Air 2S in JPEG is 2 seconds.

## 2. Users and goals

- Primary user: a single operator planning forest blocks at home, then flying them in the field with poor or no mobile signal.
- Goal: produce a set of Litchi missions that, flown in sequence, give WebODM well-overlapped nadir (and optional crosshatch) imagery of a polygon, with safe clearance above terrain and canopy.

## 3. Features

### 3.1 Site and area
- **[MVP]** New areas start as a 200 m square with takeoff 20 m south. Drag corners, tap or drag edge + handles to add corners, double-tap a corner to delete it, drag the centre handle to move the area.
- **[MVP]** Import a boundary from KML or GeoJSON.
- **[MVP]** Set takeoff point by tapping the map or using the device's GPS.
- **[MVP]** Multiple named plans saved on the device: new, open, rename, duplicate, delete (with confirm).
- **[MVP]** Reset: new plan, new square, reset settings to defaults.
- **[MVP]** Export one or all plans to a `.json` plan file (share sheet on iOS); import adds plans without overwriting, renames clashes, skips invalid entries with reasons, refuses newer format versions.
- **[v2]** Exclusion zones (holes) inside the polygon.

### 3.2 Camera model
- **[MVP]** Built-in Air 2S profile: sensor 13.2 x 8.8 mm, focal length 8.38 mm, 5472 x 3648 px, min interval 2 s.
- **[MVP]** Derived values: GSD, ground footprint (across and along track), line spacing, photo spacing.
- **[v2]** Custom camera profiles for other drones.

### 3.3 Flight parameters
- **[MVP]** Altitude above ground/canopy (m).
- **[MVP]** Front and side overlap (%), defaults 80/80.
- **[MVP]** Speed (m/s), default 5.
- **[MVP]** Grid angle (deg), with auto mode aligned to the polygon's longest edge.
- **[MVP]** Gimbal pitch, default -90.
- **[MVP]** Trigger mode: distance interval (default) or time interval.
- **[MVP]** Edge buffer: extend lines past the polygon by a set distance so edges get full coverage.
- **[v1]** Crosshatch: second grid at +90 deg, exported as separate missions.
- **[v1]** Oblique gimbal option for crosshatch passes.

### 3.4 Terrain and canopy
- **[MVP, done]** Elevation from AWS Terrain Tiles (Terrarium PNG, z14; global SRTM 30 m, 5 m lidar in Australia). Loaded automatically for the area plus a 200 m margin; cached by the service worker for offline use; retried when back online.
- **[MVP, done]** Altitude setting is height above the treetops. Tree height setting is added to ground elevation to estimate treetops.
- **[MVP, done]** Terrain following: sample each line every 10 m, insert waypoints where straight-line interpolation deviates from the target by more than 5 m.
- **[MVP, done]** Climb waypoint above takeoff, only as high as needed to clear the trees to the first line.
- **[MVP, done]** Clearance checked every 10 m along every leg (lines, turns, climb-out); height above bare ground vs legal limit; vertical speed per leg; documented Air 2S Straight Line and signal-loss return branches checked as detailed below.
- **[v1]** User-supplied GeoTIFF DEM (DEMNAS) and canopy height raster (ETH global canopy height).
- **[v1]** Elevation profile chart per line.
- Note: SRTM is radar and in dense forest records a surface partway up the canopy, so ground + tree height overestimates treetops there. That errs on the safe side.

### 3.5 Mission splitting
- **[MVP]** Split into missions of at most 99 waypoints.
- **[MVP]** Split by battery: estimated flight time per mission (including transit from and back to home) must not exceed usable battery time minus reserve. Defaults: 27 min battery, 30% reserve.
- **[MVP]** Each mission starts at the end nearest home.
- **[v1]** Takeoff-point variants: generate the full mission set for up to three alternative takeoff points in one export.

### 3.4a Rock formations and elevation-data limits (adversarial review, 27 Oct 2026)
- **[done]** Conservative terrain model: obstacles = highest DEM value within 30 m; clearance design uses the lowest takeoff elevation within 30 m. Maximum height and absolute KML use DEM elevation at the actual takeoff position, including the extra commanded relative height.
- **[done]** Terrain following climbs before rock faces (profile limited to 2.5 m/s vertical) and never dips more than 1 m below target.
- **[done]** Steep-terrain detection (DEM slope > 100% over 20 m) blocks export until the user enters a field measurement: "Rock formation height" (added to the elevation data everywhere; keeps terrain following) or "Highest obstacle above takeoff" (a floor, plus minimum clearance, for the flight and RTH). Steepest point marked on the map.
- **[done]** DJI Fly max altitude setting; export blocked when a waypoint or RTH needs more.
- **[done]** Field obstacle measurements are bound to exact area/takeoff coordinates; formation measurements are bound to the area. Geometry changes or legacy measurements without context block export until remeasured and confirmed in Settings.
- **[done]** Air 2S Straight Line RTH checks current-altitude returns at 5–50 m and climb-to-setting returns beyond 50 m. Flight positions are sampled every 1 m near home and up to 5 m elsewhere; return ground every 5 m. Signal-loss validation covers up to 50 m of historical retracing, including fixed trigger altitude and historical altitude envelopes, and direct returns if the link recovers mid-retrace. Maximum height includes these paths. This sampled model does not certify other aircraft or Power Saving RTH.
- **[done]** Every site requires an explicit geometry-bound survey of the flight/return corridors and a clear landing area at least 5 m around takeoff, independently of DEM steepness or zero obstacle allowances. Legacy plans need a first survey confirmation. Updating height allowances requires reconfirmation.
- **[done]** Invalid/nonfinite elevation samples throw a planning error, including with a flat fallback confirmation. CSV and KML independently reject nonfinite flight numbers; malformed tile dimensions are rejected before decoding.
- **[done]** Terrain allocation capped at 1,000,000 grid cells and elevation requests at 256 tiles. Invalid bounds and excessive takeoff distance are refused before terrain work.
- **[done]** A memory-only storage fallback always reports plans as unsaved, including when browser storage is unavailable at startup.
- **[done]** Flat-ground confirmation only counts for the area it was given for.
- **[done]** Export screen and report: DJI Fly settings and documented Air 2S return branches; require fresh missions from takeoff after interruption or changed field heights. Manual waypoint offsets invalidate the checks and timing. No unvalidated transit to stopped waypoints or obstacle avoidance in Litchi missions.
- `src/core/adversarial.test.ts`: six rock scenarios (tower, sub-resolution spire, cliff, valley takeoff, misregistered DEM, tower cluster) evaluated against the true surface with a simulated 30 m SRTM.

### 3.5a Itinerary
- **[MVP, done]** One exported itinerary per mission (climb over takeoff, transit at 10 m/s with photos off, mapping lines with intermediate terrain waypoints, turns) drives the battery estimate, safety checks, Litchi CSV and KML.
- **[MVP, done]** Legs longer than 1500 m are subdivided (Litchi accepts 0.6 to 1999 m).
- **[MVP, done]** Climb-out altitude chosen so the leg out needs at most 3 m/s vertical and clears the trees.

### 3.6 Export
- **[MVP]** Litchi CSV per mission, full 46-column header, with:
  - altitude per waypoint (above takeoff), altitudemode 0
  - speed per waypoint
  - gimbal pitch on every waypoint (gimbalmode 2)
  - heading along the line
  - curvesize 0.2 (non-zero, straight-line behaviour)
  - photo_distinterval or photo_timeinterval on line waypoints, -1 on transit waypoints
- **[MVP]** KML export of all missions with absolute altitudes, for review in Google Earth.
- **[MVP]** Plan report (text/HTML): parameters, per-mission stats, all check results, pre-flight checklist.
- **[MVP]** Download as files; Web Share API on iOS.
- **[MVP, done]** Export screen and report list the Litchi mission settings the CSV cannot carry: finish action Go Home, path mode Straight lines, heading Toward next waypoint, mission photo interval off, altitudes relative to takeoff.
- Note: non-photo waypoints are written with photo interval -1. Litchi's waypoint docs say a waypoint defaults to "use mission setting"; whether -1 or 0 means "off" is unverified, so the mission-level interval must be off (field test 7).
- **[v1]** ZIP bundle of all files.

### 3.7 Checks
Each check returns pass, caution (amber, export allowed with explanation) or fail (red, blocks export).

| Check | Fail | Caution |
|---|---|---|
| Waypoints per mission | > 99 | |
| Photo interval (time mode) | < 2 s | < 2.5 s |
| Distance interval implied time at speed | < 2 s | < 2.5 s |
| Mission time vs battery minus reserve | exceeds | within 10% |
| Max distance from takeoff | > user limit (default 1000 m) | > 80% of limit |
| Max altitude above takeoff | > 120 m (user configurable for local rules) | > 90% |
| Worst-case forward overlap (speed +20%, time mode only) | < 60% | < target |
| Min clearance above canopy along path [v1] | < user min (default 30 m) | < 1.5x min |
| Climb gradient [v1] | > 4 m/s vertical at planned speed | > 3 m/s |
| Takeoff point distance to polygon | > limit | > 50% of limit |
| Elevation data loaded | none or partial, unless flat ground confirmed | flat ground confirmed |
| Litchi limits | leg < 0.6 m or > 1999 m; altitude < -200 m or > 500 m; photo interval > 100 | supported waypoint below takeoff |
| RTH height above the configured height limit | yes, including valleys on the return | |
| GEO zone checked | | not ticked |

### 3.8 Guidance and UX
- **[MVP]** Step flow: Site → Takeoff → Parameters → Review → Export. Each step usable on a phone.
- **[MVP]** Plain-language help text on every parameter.
- **[MVP]** Live stats as parameters change: GSD, photo count, line count, total distance, flight time, battery count, waypoint count.
- **[MVP]** Map preview: polygon, flight lines coloured by mission, takeoff point.
- **[MVP]** Check panel with green/amber/red status and reasons.
- **[v1]** Elevation profile chart per line.
- **[v1]** Photo footprint overlay.
- **[v1]** Field mode: large-text mission cards (mission number, battery, duration, max altitude, far distance, start waypoint).

### 3.9 Offline
- **[MVP]** PWA with service worker: app shell works offline after first load.
- **[MVP]** Plans saved in localStorage.
- **[v1]** Offline elevation and imagery data in IndexedDB.
- **[v1]** "Download site for offline": DEM, canopy raster and base map tiles for the bounding box stored in IndexedDB. Base map from OpenStreetMap-derived tiles that permit caching; no caching of Google or Esri imagery.
- **[v1]** User-supplied georeferenced image overlay (e.g. Sentinel-2) as offline satellite background.

### 3.10 Pre-flight checklist (in report)
- DJI FlySafe GEO zone checked for the polygon, unlock obtained if needed
- Local permits (CASA / Indonesian DGCA, national park permit) in hand
- DJI Fly updated and GEO database synced while online
- Missions synced to Litchi and confirmed visible offline
- Camera: JPEG (or RAW+JPEG), fixed or locked exposure, focus at infinity, gimbal nadir
- SD card free space vs photo count
- Batteries charged, count matches plan
- Actual takeoff point matches plan; GPS lock; line of sight to the far corner

## 4. Non-goals
- Flying the drone. The app only writes files.
- Photogrammetry processing.
- DJI GEO zone lookup (no public API); the app links out to the FlySafe map.

## 5. Architecture
- Vite, vanilla TypeScript, no UI framework.
- MapLibre GL JS for the map, OpenStreetMap raster tiles.
- Turf.js for geometry.
- vite-plugin-pwa (Workbox) for offline.
- Planning engine in `src/core/` as pure functions with no DOM access, fully unit tested with Vitest.
- Geometry: plan in a local metric frame (equirectangular projection around the polygon centroid), convert back to WGS84 for export. Accurate to well under 1 m for blocks of a few km.
- Deployed to GitHub Pages via GitHub Actions on push to `main`.

## 6. Tests

### 6.1 Unit tests (Vitest, `src/core/*.test.ts`)

Camera
- GSD at 100 m for Air 2S is 2.88 cm/px (±0.02).
- Footprint at 100 m is 157.5 x 105.0 m (±0.5), long side across track.
- Line spacing at 80% side overlap equals footprint width x 0.2.
- Photo spacing at 80% front overlap equals footprint height x 0.2.

Projection
- Round trip WGS84 → local → WGS84 within 0.01 m for points up to 5 km from origin.
- Distance in local frame matches Turf geodesic distance within 0.5%.

Grid generation
- Rectangle 200 x 100 m, line spacing 20 m, angle 0: produces 6 lines (with half-spacing inset), all within buffered polygon.
- Lines alternate direction (serpentine).
- Auto angle on a long thin rectangle aligns with the long edge (±1 deg).
- Concave polygon (L-shape): no line segment crosses outside the polygon beyond the edge buffer.
- Rotating the grid angle by 180 deg gives the same set of lines.

Overlap math
- Time interval at 5 m/s with 10 m spacing is 2 s.
- Worst-case forward overlap at speed +20% matches hand calculation.

Mission splitting
- A plan with 250 waypoints splits into 3 missions, each ≤ 99.
- No mission exceeds battery minus reserve including transit.
- Lines are never split mid-line unless a single line exceeds the limits (then split with a warning).
- Each mission's first waypoint is the line end nearest takeoff.

Litchi CSV
- Header matches the 46-column Litchi format exactly.
- Every row has 46 fields.
- curvesize is never 0.
- Line waypoints carry the distance or time interval; transit waypoints carry -1.
- Parsing the CSV back yields identical coordinates (6 decimal places), altitudes and speeds.

Checks
- Each check returns the right status at its boundary values (just below, at, just above threshold).
- Any fail blocks export; cautions do not.

Terrain [v1]
- Flat DEM: no extra waypoints inserted.
- Linear slope: no extra waypoints (interpolation is exact).
- Sinusoidal terrain: inserted waypoints keep max deviation ≤ tolerance.
- Altitude above takeoff = surface elevation + AGL − takeoff elevation.
- Clearance check catches a ridge between two waypoints.

### 6.2 Integration tests
- Build succeeds; service worker and manifest present in `dist/`.
- Playwright smoke test [v1]: load page, draw polygon via test hook, export CSV, CSV parses.
- Offline [v1]: after first load, reload with network disabled; app renders and loads saved plan.

### 6.3 Manual and field tests
1. Import generated CSV into Litchi Mission Hub. Confirm waypoint count, altitudes and photo interval settings display correctly.
2. Open the KML in Google Earth with terrain. Confirm paths sit above terrain.
3. DJI Assistant 2 simulator with the Air 2S connected by USB, props off: fly one mission in Litchi, confirm photos are triggered and the path matches.
4. Home test flight on a small flat block: confirm distance-interval triggering works on the Air 2S under virtual stick, count photos vs plan, process in WebODM.
5. Test the Litchi "start from waypoint" option after deliberately stopping a mission mid-line.
7. Import a CSV in Litchi Hub with a mission photo interval set, and check whether waypoints written with -1 inherit it. Repeat with 0 to see whether 0 means off or "as fast as possible".
6. Install as PWA on iPhone, enable airplane mode, open app, view plan and report.

## 7. Open questions to verify
- Does Litchi honour `photo_distinterval` on the Air 2S under virtual stick? (field test 4)
- Does the new Litchi Hub (2025) import CSV the same way as the old Mission Hub? (manual test 1)
- Does "start at waypoint" work for the Air 2S? (field test 5)
