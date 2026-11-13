"""Render Excalidraw JSON to PNG using Playwright + headless Chromium.

Usage:
    cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references"
    uv run python render_excalidraw.py <path-to-file.excalidraw> [--output path.png] [--scale 1] [--width 1920]

First-time setup:
    cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references"
    uv sync
    uv run playwright install chromium

Network prerequisite: esm.sh reachable (renderer imports the pinned @excalidraw/excalidraw ES module
named in render_template.html). A cold first load of that bundle took 36–44 s on 2026-11-13, so the
module wait defaults to DEFAULT_LOAD_TIMEOUT_MS; raise it with --load-timeout-ms or
EXCALIDRAW_LOAD_TIMEOUT_MS.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

# A cold load of the pinned Excalidraw bundle from esm.sh measured 36–44 s (2026-11-13).
DEFAULT_LOAD_TIMEOUT_MS = 120_000
MODULE_URL_RE = re.compile(r'EXCALIDRAW_MODULE_URL\s*=\s*"([^"]+)"')


def module_url_of(template_path: Path) -> str:
    """The one Excalidraw module URL the template imports (the single place its version lives)."""
    m = MODULE_URL_RE.search(template_path.read_text(encoding="utf-8"))
    return m.group(1) if m else "(EXCALIDRAW_MODULE_URL not found in render_template.html)"


def load_timeout_ms(cli_value: int | None) -> int:
    if cli_value:
        return cli_value
    env = os.environ.get("EXCALIDRAW_LOAD_TIMEOUT_MS", "").strip()
    return int(env) if env.isdigit() and int(env) > 0 else DEFAULT_LOAD_TIMEOUT_MS


def validate_excalidraw(data: dict) -> list[str]:
    """Validate Excalidraw JSON structure. Returns list of errors (empty = valid)."""
    errors: list[str] = []

    if data.get("type") != "excalidraw":
        errors.append(f"Expected type 'excalidraw', got '{data.get('type')}'")

    if "elements" not in data:
        errors.append("Missing 'elements' array")
    elif not isinstance(data["elements"], list):
        errors.append("'elements' must be an array")
    elif len(data["elements"]) == 0:
        errors.append("'elements' array is empty — nothing to render")

    return errors


def compute_bounding_box(elements: list[dict]) -> tuple[float, float, float, float]:
    """Compute bounding box (min_x, min_y, max_x, max_y) across all elements."""
    min_x = float("inf")
    min_y = float("inf")
    max_x = float("-inf")
    max_y = float("-inf")

    for el in elements:
        if el.get("isDeleted"):
            continue
        x = el.get("x", 0)
        y = el.get("y", 0)
        w = el.get("width", 0)
        h = el.get("height", 0)

        # For arrows/lines, points array defines the shape relative to x,y
        if el.get("type") in ("arrow", "line") and "points" in el:
            for px, py in el["points"]:
                min_x = min(min_x, x + px)
                min_y = min(min_y, y + py)
                max_x = max(max_x, x + px)
                max_y = max(max_y, y + py)
        else:
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + abs(w))
            max_y = max(max_y, y + abs(h))

    if min_x == float("inf"):
        return (0, 0, 800, 600)

    return (min_x, min_y, max_x, max_y)


def render(
    excalidraw_path: Path,
    output_path: Path | None = None,
    scale: int = 1,
    max_width: int = 1920,
    timeout_ms: int = DEFAULT_LOAD_TIMEOUT_MS,
) -> Path:
    """Render an .excalidraw file to PNG. Returns the output PNG path."""
    # Import playwright here so validation errors show before import errors
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("ERROR: playwright not installed.", file=sys.stderr)
        print('Run: cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references" && uv sync && uv run playwright install chromium', file=sys.stderr)
        sys.exit(1)

    # Read and validate
    raw = excalidraw_path.read_text(encoding="utf-8")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON in {excalidraw_path}: {e}", file=sys.stderr)
        sys.exit(1)

    errors = validate_excalidraw(data)
    if errors:
        print(f"ERROR: Invalid Excalidraw file:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        sys.exit(1)

    # Compute viewport size from element bounding box
    elements = [e for e in data["elements"] if not e.get("isDeleted")]
    min_x, min_y, max_x, max_y = compute_bounding_box(elements)
    padding = 80
    diagram_w = max_x - min_x + padding * 2
    diagram_h = max_y - min_y + padding * 2

    # Cap viewport width, let height be natural
    vp_width = min(int(diagram_w), max_width)
    vp_height = max(int(diagram_h), 600)

    # Output path
    if output_path is None:
        output_path = excalidraw_path.with_suffix(".png")

    # Template path (same directory as this script)
    template_path = Path(__file__).parent / "render_template.html"
    if not template_path.exists():
        print(f"ERROR: Template not found at {template_path}", file=sys.stderr)
        sys.exit(1)

    template_url = template_path.as_uri()
    module_url = module_url_of(template_path)

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Exception as e:
            if "Executable doesn't exist" in str(e) or "browserType.launch" in str(e):
                print("ERROR: Chromium not installed for Playwright.", file=sys.stderr)
                print('Run: cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references" && uv run playwright install chromium', file=sys.stderr)
                sys.exit(1)
            raise

        page = browser.new_page(
            viewport={"width": vp_width, "height": vp_height},
            device_scale_factor=scale,
        )

        # Load the template
        page.goto(template_url)

        # Wait for the ES module to load (imports from esm.sh) OR explicit error.
        # A cold load is slow (tens of seconds), so the wait is long and says what it waits for.
        print(f"loading {module_url} (timeout {timeout_ms // 1000}s; a cold load can take ~40s)", file=sys.stderr)
        try:
            page.wait_for_function(
                "window.__moduleReady === true || typeof window.__moduleError !== 'undefined'",
                timeout=timeout_ms,
            )
        except Exception:
            print(
                f"ERROR: Timed out after {timeout_ms // 1000}s loading {module_url}. The host may answer while "
                "this bundle is still building or slow; check the URL with curl, then raise the wait with "
                "--load-timeout-ms or EXCALIDRAW_LOAD_TIMEOUT_MS.",
                file=sys.stderr,
            )
            browser.close()
            sys.exit(1)

        module_error = page.evaluate("window.__moduleError")
        if module_error:
            print(
                f"ERROR: Failed to load {module_url}: {module_error}. If a sub-import answers 404, the pinned "
                "version in render_template.html needs to move.",
                file=sys.stderr,
            )
            browser.close()
            sys.exit(1)

        # Inject the diagram data and render
        json_str = json.dumps(data)
        result = page.evaluate(f"window.renderDiagram({json_str})")

        if not result or not result.get("success"):
            error_msg = result.get("error", "Unknown render error") if result else "renderDiagram returned null"
            print(f"ERROR: Render failed: {error_msg}", file=sys.stderr)
            browser.close()
            sys.exit(1)

        # Wait for render completion signal
        page.wait_for_function("window.__renderComplete === true", timeout=timeout_ms)

        # Screenshot the SVG element
        svg_el = page.query_selector("#root svg")
        if svg_el is None:
            print("ERROR: No SVG element found after render.", file=sys.stderr)
            browser.close()
            sys.exit(1)

        # A large diagram can take longer than Playwright's 30 s default to settle and capture
        # (seen 2026-11-13 under load: "waiting for element to be stable").
        svg_el.screenshot(path=str(output_path), timeout=timeout_ms)
        browser.close()

    return output_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Render Excalidraw JSON to PNG")
    parser.add_argument("input", type=Path, help="Path to .excalidraw JSON file")
    parser.add_argument("--output", "-o", type=Path, default=None, help="Output PNG path (default: same name with .png)")
    parser.add_argument(
        "--scale",
        "-s",
        type=int,
        default=1,
        help="Device scale factor (default: 1 — Excalidraw already exports at 2x; 2 made 7000-px PNGs, 2026-11-13)",
    )
    parser.add_argument("--width", "-w", type=int, default=1920, help="Max viewport width (default: 1920)")
    parser.add_argument(
        "--load-timeout-ms",
        type=int,
        default=None,
        help=f"Wait for the Excalidraw module and the render (default: EXCALIDRAW_LOAD_TIMEOUT_MS or {DEFAULT_LOAD_TIMEOUT_MS})",
    )
    args = parser.parse_args()

    if not args.input.exists():
        print(f"ERROR: File not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    png_path = render(args.input, args.output, args.scale, args.width, load_timeout_ms(args.load_timeout_ms))
    print(str(png_path))


if __name__ == "__main__":
    main()
