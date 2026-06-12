# Third-Party Notices — local:lottie skill

## diffusionstudio/lottie (text-to-lottie)

- Upstream: <https://github.com/diffusionstudio/lottie>
- License: MIT — Copyright (c) 2026 Diffusion Studio Inc.
- What is vendored: the Lottie/Bodymovin authoring rules and verification
  checklist from `skills/text-to-lottie/SKILL.md`, adapted for the soma-work
  runtime in [`../SKILL.md`](../SKILL.md). Upstream's Skottie/Vite player is
  not vendored; this skill substitutes a Playwright + lottie-web validator
  ([`../validator/validate.mjs`](../validator/validate.mjs)) and documents the
  upstream player as the "deep mode" path.

MIT License

Copyright (c) 2026 Diffusion Studio Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## lottie-web (runtime referenced at render time, not vendored)

- Upstream: <https://github.com/airbnb/lottie-web>
- License: MIT — Copyright (c) 2015 Bodymovin
- Referenced via pinned CDN URL
  (`https://cdn.jsdelivr.net/npm/lottie-web@5.13.0/build/player/lottie.min.js`)
  in generated HTML artifacts and in the validator. No source is vendored.
