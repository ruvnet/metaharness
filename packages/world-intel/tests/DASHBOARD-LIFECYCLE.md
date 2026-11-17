# Dashboard lifecycle validation

`dashboard-sockets.test.ts` uses real ephemeral `127.0.0.1` port-zero listeners,
mocked providers, and guaranteed `finally` shutdown. It verifies same/cross-origin
requests, Host rejection, body limits, HEAD response behavior, SSE disconnect
cancellation, paused-reader backpressure shutdown, idempotent close and read-only
policy even when the caller permits writes. It contacts no external providers.

`dashboard-browser.test.ts` is opt-in:

```
WORLD_INTEL_BROWSER_SMOKE=1 npm exec -- vitest run tests/dashboard-browser.test.ts
```

Use already-installed Playwright and Chromium, with optional
`WORLD_INTEL_PLAYWRIGHT`, `WORLD_INTEL_CHROMIUM`, and
`WORLD_INTEL_BROWSER_ASSETS` paths. No browser is installed by this test.
The assets directory must contain the official versioned distributions:

- `leaflet.js` and `leaflet.css`: Leaflet 1.9.4 `dist/`
- `markercluster.js`: leaflet.markercluster 1.5.3 `dist/leaflet.markercluster.js`
- `markercluster.css`: leaflet.markercluster 1.5.3 `dist/MarkerCluster.css`
- `purify.min.js`: DOMPurify 3.4.18 `dist/purify.min.js`

The sanitizer SHA384 is verified before browser launch. Browser routing locally
fulfills those exact CDN asset URLs and aborts every other non-loopback page
request, including map tiles and external fonts. API data is mocked. Both the
browser and listener close in `finally`; default test runs skip browser execution.

Observed in the execution workspace: four real socket tests passed. The installed
Chromium could not launch because its process-singleton Unix socket was denied
(`socket() failed: Operation not permitted`), including an approved elevated
retry. Browser-render assertions therefore remain unverified in this environment;
this must not be reported as a rendering pass. Failed launches were terminated
and the ephemeral listener was closed. No heavyweight browser install or
persistent/public deployment was performed.
