# DroneCraft

Plan photogrammetry grid missions for the DJI Air 2S and export them as Litchi CSV files. Built for forest mapping, works offline once installed.

**App:** https://geekrebel.github.io/dronecraft/

## Using it

1. **Area**: tap the map to place corners, or import a KML/GeoJSON boundary.
2. **Takeoff**: tap where you'll launch, or use your GPS position.
3. **Settings**: altitude, overlap, speed, trigger mode, limits. Every setting has a short explanation.
4. **Review**: ground resolution, photo count, flight time, and safety checks (green, amber, red). Red blocks export.
5. **Export**: one Litchi CSV per battery, a KML for Google Earth, and a plan report with a pre-flight checklist.

Import each CSV in Litchi Mission Hub, then confirm the missions show up on your phone before you lose signal.

### Install for offline use (iPhone)
Open the app in Safari, Share → Add to Home Screen. Open it once from the home screen while online. After that it runs without a connection. Plans are stored on the device.

## Limits to know
- The Air 2S has no onboard waypoints. Litchi flies it by virtual stick, so the mission stops if the controller link drops.
- With elevation loaded, missions follow a conservative terrain model. Missing elevation blocks export unless you confirm the site is flat. Narrow rocks and trees still need field measurements.
- Moving the area or takeoff invalidates the relevant field measurements. Remeasure and confirm them in Settings before exporting again; older saved measurements need a first confirmation too.
- Height checks include the return routes and the extra altitude commanded around uncertain takeoff terrain. Large terrain requests and distant takeoff points are refused before elevation loading.
- If browser storage is unavailable, a "not saved" warning stays visible. Export your plans before closing the app.
- Distance-based photo triggering is written to the CSV; confirm it works on your drone in a test flight.

## Development
```
npm install
npm run dev      # local dev server
npm test         # unit tests for the planning engine
npm run build    # production build in dist/
```
Pushing to `main` runs the tests and deploys to GitHub Pages.

See [SPEC.md](SPEC.md) for the full feature list, roadmap and test plan.
