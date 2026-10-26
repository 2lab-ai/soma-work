---
name: LINE
colors:
  primary: '#06c755'
  android-primary: '#4cc764'
  canvas: '#ffffff'
  foreground: '#000000'
  text-secondary: '#616161'
  text-muted: '#949494'
  border: '#e8e8e8'
  outline: '#efefef'
  action-blue: '#638dff'
  danger: '#ff334b'
  on-primary: '#ffffff'
typography:
  marketing-hero:
    fontSize: 70px
    fontWeight: 700
    use: Public line.me Life on LINE heading
  marketing-service:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.334
    use: Public line.me Messenger and Services headings
  heading-1:
    fontSize: 24px
    fontWeight: 900
    use: Messenger product heading 1; official Heavy role
  heading-2:
    fontSize: 17px
    fontWeight: 700
    use: Messenger product heading 2
  title-1:
    fontSize: 23px
    fontWeight: 700
    use: Messenger product title 1
  title-3:
    fontSize: 16px
    fontWeight: 500
    use: Messenger product title 3; Medium or Semibold
  body-1:
    fontSize: 16px
    fontWeight: 400
    use: Messenger primary body
  body-2:
    fontSize: 14px
    fontWeight: 400
    use: Messenger secondary body
  body-4:
    fontSize: 12px
    fontWeight: 400
    use: Minimum recommended Messenger body role
rounded:
  button: 5px
  button-large: 6px
  full: 9999px
spacing:
  gutter-4-column: 5
  gutter-3-column: 8
  gutter-2-column: 9
  screen-margin: 16
  card-margin: 16
components:
  box-button-primary:
    type: button
    backgroundColor: '#06c755'
    textColor: '#ffffff'
    rounded: 5px
    height: 36px
    states: active, inactive, pressed, loading, on, off
    use: Primary general action; official medium box-button geometry
  box-button-destructive:
    type: button
    backgroundColor: '#ff334b'
    textColor: '#ffffff'
    rounded: 5px
    height: 36px
    states: active, inactive, pressed, loading
    use: Delete, replace, remove, and other destructive actions
  box-button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #efefef'
    rounded: 5px
    height: 36px
    states: active, inactive, pressed, loading, off
    use: Secondary or turned-off box-button action
  capsule-button:
    type: button
    backgroundColor: '#06c755'
    textColor: '#ffffff'
    rounded: 9999px
    states: active, pressed; disappears after completing its scroll action
    use: Move to new content above or below the current scroll position
  text-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '0 0 1px solid #949494'
    states: 'inactive, focused #06c755, typing, completed, error #ff334b, disabled'
    use: Text, password, and code input with required underline and reset action
  popup:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#000000'
    states: light, dark, one-button, two-button, three-button, affirmative-disabled
    use: Important information or user decision with content, action area, and scrim
  tabs:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    border: 'selected indicator uses #06c755'
    states: selected, unselected, pressed
    use: Text, box, or icon grouping at the top of dependent content
  notification-badge:
    type: badge
    backgroundColor: '#06c755'
    textColor: '#ffffff'
    rounded: 9999px
    use: N, dot, or number update badge; red is reserved for GNB placement
fonts:
  roles:
    sans: System
    display: LINESeed
  faces:
    LINESeed:
      name: LINE Seed
      evidence:
        - live-surface-use
        - official-distributed-asset
      surface: marketing and design-system documentation display roles
      source: https://seed.line.me/index_en.html
      licence: OFL-1.1
      distribution: public
      note: Messenger product UI uses each platform's system font instead.
---

# LINE

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to LINE; reproduced for educational reference. Full prose: https://oh-my-design.kr/line/design.md
