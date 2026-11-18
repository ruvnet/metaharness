# Geographic numerical kernel

`geo.ts` is AssemblyScript, compiled to real WebAssembly with no host imports.
Rebuild with pinned AssemblyScript 0.27.31:

```sh
asc wasm/geo.ts --outFile wasm/geo.wasm --runtime stub --optimize --noAssert
```

The TypeScript wrapper validates inputs. `distanceKm` uses a mean-radius sphere,
not ellipsoidal surveying, road routing or billable distance. `containsBBox`
accepts inclusive latitude/longitude edges and antimeridian-crossing boxes
(`west > east`). Both representations of the 180-degree meridian are equivalent.
The exported TS fallback has the same contract. Callers explicitly select and
load the trusted bundled WASM bytes; no remote download or silent fallback occurs.

This small numerical path establishes portable execution and parity. It does not
claim a speed advantage over JavaScript or whole-server WASM execution. Network
I/O, source validation and MCP protocol handling remain TypeScript.
