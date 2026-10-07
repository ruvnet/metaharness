# README motion system

The editorial source is [storyboard.json](storyboard.json). The generator uses only the Python standard library:

```bash
python3 scripts/generate-readme-visuals.py
```

Run it from the repository root. It regenerates `docs/assets/visuals/` and `docs/visual-walkthrough.md`. Output is deterministic. Edit the storyboard for copy, source links, chapter ordering, and the four-scene trailer selection. Edit the generator for geometry, layout, or timing.

## Design

- Near-black canvas, pale cyan geometry, mint signals, orange trajectories.
- A compact 960 × 540 chapter canvas, 960 × 348 hero, and 960 × 156 section headers.
- Native SVG paths, CSS, and SMIL. No scripts, external fonts, remote images, or runtime libraries.
- Rotating 4D projections, toroidal and spherical lattices, hyperbolic-style radial fields, animated icons, and directional data-flow packets. Geometry is illustrative, not an implementation claim.
- Eight seconds per scene in the trailer and full tour. Individual chapters loop continuously.
- Reduced-motion media queries hide SMIL geometry and show a static alternative. CSS motion stops. The tour shows its opening chapter; each chapter is also available separately.
- Every SVG has a title and description; the walkthrough includes selectable text and source links for every chapter.

## Review changes

Validate SVG XML and local links, render desktop and phone-width previews, and inspect the opening frame, transitions, and reduced-motion state in a browser when available. Keep important labels large, and retain text equivalents below diagrams. Do not add invented timings, benchmark numbers, live-status indicators, or claims unsupported by source documentation.

Generated files are committed so GitHub can display them directly. README images link to the full walkthrough or the relevant documented workflow. GitHub caching can briefly show an earlier image after a commit.
