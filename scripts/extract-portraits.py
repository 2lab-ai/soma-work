#!/usr/bin/env python3
"""Extract individual portraits from 6x7 grid source images.

Source images: assets/source/Gemini_Generated_Image_*.png (1844x2304)
Output: assets/profile/{name}_{col}_{row}.png

Grid: 6 columns x 7 rows per image
1) Crop cell with generous margins to remove text labels
2) Auto-trim gray background per portrait
3) Resize all to uniform OUTPUT_SIZE
"""

from pathlib import Path
from PIL import Image

COLS = 6
ROWS = 7
TOP_CUT = 30
BOTTOM_CUT = 30

# Background detection
BG_COLOR = (193, 193, 193)
BG_TOLERANCE = 40  # per-channel distance from BG_COLOR to count as background

# Final uniform output size
OUTPUT_SIZE = (250, 250)

# Image 1: World Leaders (bhqze6)
WORLD_NAMES = [
    ["칭기즈칸", "나폴레옹", "카이사르", "을지문덕", "알렉산더", "샤를마뉴"],
    ["한니발", "오다노부나가", "조지워싱턴", "이순신", "손자", "엘리자베스1세"],
    ["살라딘", "잔다르크", "프리드리히대왕", "세종대왕", "도쿠가와이에야스", "예카테리나2세"],
    ["윌리엄1세", "칸의비상", "도요토미히데요시", "넬슨제독", "조선세종", "나폴레옹제독"],
    ["구스타브아돌프", "아틸라", "도요토미히데요시", "진시황", "조선세종", "나폴레옹제독"],
    ["구스타브아돌프", "아틸라", "미야모토무사시", "진시황", "시몬볼리바르", "줄리어스카이사르"],
    ["술레이만", "조카", "만사무사", "루이XIV", "오다노부나가", "알렉산더"],
]

# Image 2: Three Kingdoms (yniacl)
# NOTE: AI-generated text was garbled. Names below are best-effort interpretation.
# Decoded from garbled Korean phonetics: 시마이→사마의, 디요찬→초선, 자하우던→하후돈
SAMGUK_NAMES = [
    ["제갈량", "관우", "장비", "유비", "조조", "손권"],
    ["마초", "황충", "손견", "손책", "주유", "여포"],
    ["마속", "장합", "순욱", "곽가", "노숙", "방통"],
    ["제갈영", "법정", "유봉", "초선", "사마의", "하후돈"],
    ["강유", "육손", "제갈근", "등애", "관평", "장포"],
    ["강유", "노숙", "제갈진", "여몽", "관흥", "장완"],
    ["조운", "노숙", "제갈서", "노복", "사마랑", "손선"],
]

SOURCES = [
    ("assets/source/Gemini_Generated_Image_bhqze6bhqze6bhqz.png", WORLD_NAMES),
    ("assets/source/Gemini_Generated_Image_yniaclyniaclynia.png", SAMGUK_NAMES),
]


def find_content_bbox(img: Image.Image) -> tuple[int, int, int, int]:
    """Find bounding box of non-background content."""
    w, h = img.size
    rgb = img.convert("RGB")
    min_x, min_y, max_x, max_y = w, h, 0, 0

    for y in range(h):
        for x in range(w):
            r, g, b = rgb.getpixel((x, y))
            if (abs(r - BG_COLOR[0]) > BG_TOLERANCE
                    or abs(g - BG_COLOR[1]) > BG_TOLERANCE
                    or abs(b - BG_COLOR[2]) > BG_TOLERANCE):
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)

    if max_x <= min_x or max_y <= min_y:
        return (0, 0, w, h)
    return (min_x, min_y, max_x + 1, max_y + 1)


def extract_portraits(src_path: str, names: list[list[str]], out_dir: Path) -> int:
    img = Image.open(src_path).convert("RGB")
    w, h = img.size
    cell_w = w / COLS
    cell_h = h / ROWS

    portrait_w = int(cell_w)
    portrait_h = int(cell_h) - TOP_CUT - BOTTOM_CUT
    count = 0

    for row in range(ROWS):
        for col in range(COLS):
            x1 = int(col * cell_w)
            y1 = int(row * cell_h) + TOP_CUT

            cell = img.crop((x1, y1, x1 + portrait_w, y1 + portrait_h))

            # Auto-trim gray background
            bbox = find_content_bbox(cell)
            trimmed = cell.crop(bbox)

            # Resize to uniform output size (maintain aspect ratio, pad if needed)
            trimmed.thumbnail(OUTPUT_SIZE, Image.LANCZOS)
            result = Image.new("RGB", OUTPUT_SIZE, BG_COLOR)
            paste_x = (OUTPUT_SIZE[0] - trimmed.width) // 2
            paste_y = (OUTPUT_SIZE[1] - trimmed.height) // 2
            result.paste(trimmed, (paste_x, paste_y))

            name = names[row][col]
            filename = f"{name}_{col}_{row}.png"
            result.save(out_dir / filename)
            count += 1

    return count


def main():
    out_dir = Path("assets/profile")
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    for src_path, names in SOURCES:
        count = extract_portraits(src_path, names, out_dir)
        print(f"{src_path}: {count} portraits extracted")
        total += count

    print(f"\nTotal: {total} portraits saved to {out_dir}/")


if __name__ == "__main__":
    main()
