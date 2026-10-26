---
name: MUSTIT
colors:
  primary: '#d00000'
  brand: '#1f1f2c'
  canvas: '#ffffff'
  surface: '#fafafa'
  foreground: '#222222'
  muted: '#888888'
  on-primary: '#ffffff'
  accent-info: '#3083e4'
  accent-outlet: '#8c1e46'
  surface-mid: '#f5f5f5'
  hairline: '#e6e6e6'
  border-subtle: '#f0f0f0'
  disabled: '#cccccc'
typography:
  display:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.35
    use: Section hero titles
  title-l:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Modal, page headers
  title-m:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.35
    use: Section headers
  title-s:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.5
    use: Card group titles
  body-l:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Navigation links
  body-m:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.47
    use: Button labels, product name
  body-s:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    use: Product price, form labels
  caption-l:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.38
    use: Search keyword, chips
  caption-s:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.33
    use: Metadata, sizes
  label:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.45
    use: Badges, micro-copy
  fine:
    fontSize: 10px
    fontWeight: 400
    lineHeight: 1.6
    use: Legal, cart count
rounded:
  sm: 2px
  md: 4px
  lg: 8px
  full: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#333333'
    textColor: '#ffffff'
    rounded: 4px
    height: 48px
    padding: 0 16px
    typography: 15px / 600
    use: Primary black CTA
  button-confirm:
    type: button
    backgroundColor: '#d00000'
    textColor: '#ffffff'
    border: '1px solid #d00000'
    rounded: 4px
    height: 48px
    typography: 18px / 500
    use: Red confirm CTA
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #333333'
    rounded: 4px
    height: 32px
    typography: 13px / 600
    use: Secondary action
  button-disabled:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#888888'
    border: '1px solid #dddddd'
    rounded: 4px
    use: Disabled action
  tab:
    type: tab
    textColor: '#aaaaaa'
    typography: 16px / 500
    active: '2px solid #222222 bottom border, fg #222222, 16px / 700'
    use: Section tabs
  badge-outlet:
    type: badge
    backgroundColor: '#8c1e46'
    textColor: '#ffffff'
    rounded: 2px
    height: 22px
    padding: 0 8px
    typography: 11px / 700
    use: Outlet badge
  badge-info:
    type: badge
    textColor: '#3083e4'
    border: '1px solid #3083e4'
    rounded: 2px
    height: 24px
    typography: 12px / 400
    use: Info tag
  chip:
    type: badge
    border: '1px solid #cccccc'
    rounded: 17px
    height: 34px
    active: '1px solid #d00000'
    use: Filter chip
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 4px
    height: 40px
    padding: 0 12px
    typography: 15px / 600
    use: 'Search input, placeholder #aaaaaa'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Pretendard
    mono: Pretendard
---

# MUSTIT

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MUSTIT; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/mustit/DESIGN.md
