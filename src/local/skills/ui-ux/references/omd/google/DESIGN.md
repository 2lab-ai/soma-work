---
name: Google
colors:
  primary: '#1a73e8'
  canvas: '#ffffff'
  canvas-dark: '#22242a'
  foreground: '#3c4043'
  foreground-inverse: '#e8e8e8'
  muted: '#5f6368'
  outline: '#dadce0'
typography:
  display:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 56px
    letterSpacing: '-0.5px'
    use: Business Profile section heading only.
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    use: Business Profile cards, lists, and body copy.
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
    letterSpacing: 0.5px
    use: Business Profile CTA and action labels.
  search-field:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 22px
    use: Advanced Search text input; Arial system face.
rounded:
  nav: 4px
  search-key: 8px
  card: 24px
  full: 1000px
spacing:
  xs: 4
  sm: 8
  md: 16
  lg: 24
  xl: 32
components:
  business-primary:
    type: button
    backgroundColor: '#1a73e8'
    textColor: '#ffffff'
    rounded: 1000px
    padding: 8px 16px
    height: 42px
    typography: 16px / 500 / Google Sans
    states: default, hover, pressed, and focus observed on Business Profile high-emphasis action
    use: Business Profile high-emphasis action only.
    hover: '#1a72e7'
    pressed: '#185abc'
    focus: '#185abc'
  business-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a73e8'
    border: '1px solid #dadce0'
    rounded: 1000px
    padding: 8px 16px
    height: 42px
    typography: 16px / 500 / Google Sans
    states: default, hover, pressed, and focus observed on Business Profile medium-emphasis action
    use: Business Profile medium-emphasis action only.
    hover: '#1a72e6'
    pressed: '#e8f1fd'
    focus: '#e4eefc'
  business-nav:
    type: button
    textColor: '#202124'
    rounded: 4px
    padding: 0px 10px
    height: 48px
    typography: 14px / 500 / Google Sans
    states: default, hover, pressed, and focus observed on Business Profile menu item
    use: Business Profile global navigation menu item.
  business-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#3c4043'
    rounded: 24px
    padding: 18px 18px 32px
    typography: 16px / 400 / Google Sans Text
    states: disabled observed on the captured inactive image card
    use: Business Profile scrolling image card only.
  search-key:
    type: button
    backgroundColor: '#303134'
    textColor: '#e8eaed'
    border: '1px solid #303134'
    rounded: 8px
    padding: 0px 16px
    height: 36px
    typography: 14px / 500 / Arial
    states: default, hover, pressed, and focus observed on dark Search submit controls
    use: Captured dark Search homepage submit key only.
    hover: '#5f6368'
    pressed: '#5f6368'
    focus: '#5f6368'
fonts:
  roles:
    ui: Google Sans
    text: Google Sans Text
    display: Google Sans Display
    search-system: Arial
---

# Google

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Google; reproduced for educational reference. Full prose: https://oh-my-design.kr/google/design.md
