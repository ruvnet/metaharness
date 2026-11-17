# Dashboard sanitizer pin

DOMPurify is pinned to `3.4.18`, the version returned by the official npm registry
at verification on 2026-11-17. Its jsDelivr distribution bytes were fetched as
inert data and compared byte-for-byte with `package/dist/purify.min.js` from the
official npm release archive. No downloaded JavaScript was executed.

- Distribution: https://cdn.jsdelivr.net/npm/dompurify@3.4.18/dist/purify.min.js
- Archive: https://registry.npmjs.org/dompurify/-/dompurify-3.4.18.tgz
- SRI: `sha384-lkArbWjiZKuE+bzKbj1vOEF7DKYBDNvgwZMCt5OH8bdRB92zpzyNska9Q/XKPHQD`

The script tag uses `crossorigin="anonymous"` and the SHA-384 integrity value.
If loading or integrity verification fails, the UI's sanitizer wrapper falls
back to escaping all text. Existing exact Leaflet and marker-cluster version pins
are unchanged. Their CDN assets and other external fonts/tiles are not covered
by this sanitizer-specific SRI verification.

For upgrades, compare the official archive's distribution bytes with CDN bytes,
recompute SHA-384, and update the exact version, integrity value and test together.
