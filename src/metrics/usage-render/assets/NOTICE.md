# Font Attribution

**Font**: Noto Sans KR (Korean) — variable TTF
**File**: `NotoSansKR.ttf`
**Version**: sourced from [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosanskr)
**License**: SIL Open Font License, Version 1.1 (see `LICENSE`)

## Provenance

Noto Sans KR is Google's rebrand of Adobe Source Han Sans (Korean subset).
This is why the `LICENSE` file's reserved font name header reads
`'Source'` — that is the upstream copyright. The binary we ship is the
Google Noto Sans KR build, not Source Han Sans directly.

- Upstream source: https://github.com/google/fonts/tree/main/ofl/notosanskr
- Direct font file: https://github.com/google/fonts/raw/main/ofl/notosanskr/NotoSansKR%5Bwght%5D.ttf
- OFL text: https://github.com/google/fonts/raw/main/ofl/notosanskr/OFL.txt

## Usage

Loaded by `src/metrics/usage-render/carousel-renderer.ts` for rendering
`/usage card` carousel tab PNGs. The font buffer is read at runtime and
passed to `@resvg/resvg-js` as `defaultFontFamily: 'Noto Sans KR'`.
