---
name: SpaceX
colors:
  primary: '#f0f0fa'
  canvas: '#000000'
  foreground: '#f0f0fa'
  tab-selected: '#ffffff'
rounded:
  cta: 4px
  icon: 32px
  tab: 0px
spacing:
  cta-x: 20
  icon: 18
components:
  primary-cta:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.5)
    textColor: '#f0f0fa'
    border: 1px solid rgba(240, 240, 250, 0.35)
    rounded: 4px
    padding: 0px 20px
    typography: 16px / 400 / D-DIN
    states: default snapshot only; no pseudo-state variant captured
    use: Cinematic CTA on the captured public home, Mission, and Starship pages
  selected-tab:
    type: tab
    textColor: '#ffffff'
    border: 0px 0px 1px
    rounded: 0px
    padding: 0px
    typography: 16px / 600 / D-DIN
    states: selected and tab-selected after captured tab interaction
    use: Mission and Starship tab controls
  carousel-previous:
    type: button
    textColor: rgba(16, 16, 16, 0.3)
    rounded: 0px
    padding: 0px
    typography: 13.3333px / 400 / D-DIN
    disabled: disabled observed on Starship previous control
    use: Starship carousel previous control
  circular-control:
    type: button
    backgroundColor: rgba(240, 240, 250, 0.1)
    textColor: '#000000'
    rounded: 32px
    padding: 18px
    typography: 13.3333px / 400 / D-DIN
    states: default snapshot only; no variant captured
    use: Unlabelled circular control observed on all three captured public pages
omitted:
  - section: typography
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: D-DIN
    display: D-DIN-Bold
---

# SpaceX

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to SpaceX; reproduced for educational reference. Full prose: https://oh-my-design.kr/spacex/design.md
