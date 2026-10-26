---
name: ClickHouse
colors:
  primary: '#faff69'
  canvas: '#131312'
  surface: '#282828'
  overlay: '#141414'
  foreground: '#dfdfdf'
  foreground-strong: '#ffffff'
  hairline: '#414141'
  accent-border: '#4f5101'
  on-primary: '#151515'
typography:
  display:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.25
    use: Basier h2 observed on public routes
  heading:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    use: Basier h3 observed on public routes
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Inter public-route body and list items
  control:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Inter primary-action controls
  code:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.5
    use: Single observed Inconsolata body sample; not a general code-scale claim
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  dialog: 10px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  md: 8
  control: 10
  lg: 12
  xl: 16
  xxl: 24
  section: 32
components:
  public-list-item:
    type: listItem
    textColor: '#dfdfdf'
    rounded: 0px
    padding: 0px
    typography: 16px/400 Inter
    use: Repeated public-route list item; 155 observed occurrences
fonts:
  roles:
    ui: Inter
    display: Basier
    mono: Inconsolata
---

# ClickHouse

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ClickHouse; reproduced for educational reference. Full prose: https://oh-my-design.kr/clickhouse/design.md
