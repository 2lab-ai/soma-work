---
name: MiniMax
colors:
  canvas: '#ffffff'
  ink: '#18181b'
  secondary-text: '#45515e'
  muted: '#86909c'
  surface: '#f5f5f5'
  border: '#e5e7eb'
  action-dark: '#181e25'
  action-on-dark: '#ffffff'
  audio-accent: '#7659fa'
  audio-on-accent: '#f8f8f8'
typography:
  public-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    use: Repeated public home body and navigation context
  m3-display:
    fontSize: 78px
    fontWeight: 600
    lineHeight: 85.8px
    use: M3 model-launch hero heading
  careers-display:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 60px
    use: Careers-marketing headline
rounded:
  home-action: 32px
  m3-action: 8px
  audio-action: 100px
  careers-action: 9999px
spacing:
  home-action-x: 28
  m3-action-x: 12
  audio-action-x: 20
  careers-action-x: 24
  careers-action-y: 12
components:
  home-light-action:
    type: button
    backgroundColor: '#f5f5f5'
    textColor: '#181e25'
    rounded: 32px
    padding: 0px 28px
    typography: 16px / 400 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: Home marketing header action, selector home::[data-omd-capture=16]
  m3-dark-action:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 12px
    typography: 14px / 400 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: M3 launch paired dark action, selector surface-2::[data-omd-capture=20]
  m3-light-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    padding: 0px 12px
    typography: 14px / 400 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: M3 launch paired light action, selector surface-2::[data-omd-capture=21]
  audio-generate:
    type: button
    backgroundColor: '#7659fa'
    textColor: '#f8f8f8'
    rounded: 100px
    padding: 0px 20px
    typography: 14px / 500 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: Public audio-tool generate action, selector surface-3::[data-omd-capture=12]
  careers-primary:
    type: button
    backgroundColor: '#181e25'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 12px 24px
    typography: 14px / 500 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: Careers-marketing primary action, selector surface-4::[data-omd-capture=18]
    height: 44px
    pressed: 'bg #27272a (+2 nested-layer changes) (:hover + :active)'
  careers-outline:
    type: button
    textColor: '#18181b'
    border: '1px solid #18181b'
    rounded: 9999px
    padding: 12px 32px
    typography: 16px / 500 / MiSans
    states: default only; no interaction event or pseudo-state captured
    use: Careers-marketing outline action, selector surface-4::[data-omd-capture=26]
fonts:
  roles:
    ui: MiSans
    display: Outfit
---

# MiniMax

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MiniMax; reproduced for educational reference. Full prose: https://oh-my-design.kr/minimax/design.md
