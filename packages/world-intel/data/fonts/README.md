# Bundled PDF fonts

DejaVu Sans regular and bold are bundled for deterministic, offline PDF generation.
Source: the execution environment's Debian `fonts-dejavu-core` package; upstream
https://dejavu-fonts.github.io/ . See `LICENSE-DejaVu.txt` for the Bitstream Vera
license and public-domain DejaVu changes. The original font filenames are retained.

The renderer embeds only used glyph subsets. This is not a universal-script font:
characters absent from its character set become `?`, with an explicit rendering
notice in the PDF. No remote font downloads, system font discovery, HTML scripts,
images, or local-file references are evaluated.
