---
name: freee
colors:
  primary: '#2864f0'
  primary-hover: '#2863ef'
  primary-pressed: '#245ad9'
  canvas: '#ffffff'
  surface-tint: '#ebf3ff'
  text: '#323232'
  text-muted: '#595959'
  border: '#e1dcdc'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed public-site body text.
  action:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed public primary and outline action.
  heading:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed public-site heading.
rounded:
  header-action: 5px
  action: 8px
spacing:
  header-y: 4
  header-x: 20
  action-y: 10
  action-x: 16
components:
  header-primary:
    type: button
    backgroundColor: '#2864f0'
    textColor: '#ffffff'
    rounded: 5px
    padding: 4px 20px
    typography: 14px / 700 / Noto Sans JP
    hover: '#2761e8'
    use: Public header sign-up action only.
    pressed: '#2358d4'
    focus: '#2256ce'
    height: 31px
  primary-action:
    type: button
    backgroundColor: '#2864f0'
    textColor: '#ffffff'
    rounded: 8px
    padding: 10px 16px
    typography: 16px / 700 / Noto Sans JP
    hover: '#2863ee'
    use: Public pricing-page primary action only.
  segment-card:
    type: card
    backgroundColor: '#ebf3ff'
    rounded: 8px
    use: Public home segment-selection card only.
fonts:
  roles:
    ui: Noto Sans JP
  faces:
    Noto Sans JP:
      evidence:
        - live-surface-use
      source: https://github.com/notofonts/noto-cjk
      licence: OFL-1.1
      distribution: public
      note: freee self-hosts Regular, Medium and Bold OTF files.
---

# freee

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to freee; reproduced for educational reference. Full prose: https://oh-my-design.kr/freee/design.md
