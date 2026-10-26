---
name: Wisetracker
colors:
  primary: '#ff8d08'
  on-primary: '#ffffff'
  ink: '#001122'
  ink-pure: '#000000'
  canvas: '#ffffff'
  surface: '#f2f2f2'
  muted: '#8a8a8a'
  label-muted: '#b5b5b5'
  disabled: '#b0b0b0'
  accent-pink: '#ff3c96'
  accent-salmon: '#ff8da1'
  accent-magenta: '#ff53ae'
  accent-cyan: '#22ccdd'
  accent-lime: '#ccdd32'
  accent-purple: '#bb66cc'
  accent-amber: '#ffbb0e'
  docs-ink: '#1d1d1d'
  docs-muted: '#6e6e6f'
  docs-slate: '#53595f'
  docs-border: '#d8d9d9'
  docs-surface: '#f7f7f7'
typography:
  display-hero:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.2
    use: Marketing hero headline, Noto Sans CJK KR Bold
  lead:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.2
    use: Hero sub-copy, Noto Sans CJK KR Regular
  section:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: 'Section H2 titles, #001122, Noto Sans CJK KR Bold'
  feature:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.4
    use: Feature descriptions, Noto Sans CJK KR Regular
  nav-latin:
    fontSize: 16px
    fontWeight: 800
    use: Latin nav labels, Inter ExtraBold
  label-latin:
    fontSize: 14px
    fontWeight: 600
    use: Small latin labels (Product/Category), Inter SemiBold
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.2
    use: Primary CTA label, white, Noto Sans CJK KR Bold
  nav:
    fontSize: 12px
    fontWeight: 400
    use: Marketing top-nav item text
  docs-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.625
    use: 'Docs reading text, #1d1d1d, Noto Sans'
  docs-nav:
    fontSize: 14px
    fontWeight: 400
    use: Docs sidebar / top-nav links
rounded:
  sm: 4px
  md: 6px
  lg: 12px
  pill: 100px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 10
  base: 12
  lg: 20
  xl: 28
  xxl: 72
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#ff8d08'
    textColor: '#ffffff'
    rounded: 100px
    height: 56px
    padding: 0 28px
    typography: 16px / 700 Noto Sans CJK KR Bold
    shadow: subtle Framer layered
    use: Marketing primary CTA (시작하기, 무료 데모 시작) — full pill orange
  button-ghost:
    type: button
    textColor: '#000000'
    rounded: 118px
    height: 36px
    padding: 0 28px
    typography: 12px / 400
    use: Translucent-white ghost pill (데모체험)
  button-disabled:
    type: button
    backgroundColor: '#b0b0b0'
    textColor: '#ffffff'
    rounded: 100px
    height: 22px
    padding: 0 28px
    typography: 12px / 400
    use: Inactive grey pill (사업자정보 확인)
  nav-item:
    type: tab
    textColor: '#000000'
    rounded: 4px
    padding: 6px 10px
    typography: 12px / 400
    use: Marketing top-nav item (서비스/요금제/문의하기)
  badge-category:
    type: badge
    backgroundColor: '#22ccdd'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 14px / 700 Inter
    use: 'Product-category color chip (cyan/pink #ff3c96/lime #ccdd32/amber #ffbb0e coded)'
  docs-nav-item:
    type: tab
    textColor: '#6e6e6f'
    rounded: 6px
    padding: 6px 12px
    typography: 14px / 400 Noto Sans
    active: 'text #53595f, weight 600'
    use: Docs sidebar nav item
  card-docs:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #d8d9d9'
    rounded: 12px
    padding: 6px 12px
    use: Docs guide / section toggle card
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1d1d1d'
    border: '1px solid #d8d9d9'
    rounded: 6px
    padding: 8px
    typography: 14px / 400 Noto Sans
    use: Docs search field (placeholder Search…)
fonts:
  roles:
    display: Noto Sans CJK KR
    body: Noto Sans CJK KR
    latin: Inter
    docs: Noto Sans
---

# Wisetracker

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wisetracker; reproduced for educational reference. Full prose: https://oh-my-design.kr/wisetracker/design.md
