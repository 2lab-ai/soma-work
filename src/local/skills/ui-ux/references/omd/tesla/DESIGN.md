---
name: Tesla
colors:
  primary: '#3e6ae1'
  canvas: '#ffffff'
  surface: '#f4f4f4'
  foreground: '#171a20'
  body: '#393c41'
  muted: '#5c5e62'
  on-primary: '#ffffff'
rounded:
  control: 4px
  tab: 8px
  card: 8px
spacing:
  unit: 4
  gap: 8
  nav-x: 16
  card-x: 24
  card-y: 32
  card-bottom: 48
  section: 64
components:
  primary-cta:
    type: button
    backgroundColor: '#3e6ae1'
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px
    typography: 14px / 500 / Universal Sans Text
    states: pressed and focus computed snapshots
    use: Model 3 marketing CTA
    pressed: '#3e6ae0'
  high-contrast-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#393c41'
    rounded: 4px
    padding: 4px
    typography: 14px / 500 / Universal Sans Text
    states: focus computed snapshot
    use: Paired Model 3 marketing CTA
    focus: '#fefefe'
  info-card:
    type: card
    backgroundColor: '#f4f4f4'
    textColor: '#393c41'
    rounded: 8px
    padding: 0px 24px
    use: Filled information card on Model 3 marketing page
  carousel-dot:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#d0d1d2'
    rounded: 8px
    padding: 4px
    states: default and focus computed snapshots
    use: Model 3 carousel dot
    focus: '#d8d9d9'
  mode-tab:
    type: tab
    textColor: '#171a20'
    rounded: 4px
    padding: 4px 8px
    states: default, pressed, and focus computed snapshots
    use: Model 3 carousel mode tab
  carousel-navigation:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.75)
    textColor: '#393c41'
    rounded: 4px
    padding: 4px
    shadow: rgba(0, 0, 0, 0.25) 0px 4px 4px 0px
    states: default, pressed, and focus computed snapshots
    use: Inline Model 3 carousel arrow
omitted:
  - section: typography
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: Universal Sans Text
    display: Universal Sans Display
---

# Tesla

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Tesla; reproduced for educational reference. Full prose: https://oh-my-design.kr/tesla/design.md
