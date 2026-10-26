---
name: H&M
colors:
  logo: '#eb0010'
  background: '#000000'
  foreground: '#f2f2f2'
  text-subtle: '#a0a0a0'
  fill-primary-hover: '#e6e6e6'
  fill-primary-pressed: '#cccccc'
  fill-secondary-hover: '#4d4d4d'
  sunken: '#333333'
  border-subtle: '#5a5a5a'
  border-focused: '#99d3ff'
  attention: '#ed4d58'
  favourite: '#e50010'
  success: '#00713d'
  warning: '#995e00'
  info: '#66bdff'
  white: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 100
    use: calls to action, search, login and navigation — --fds-text-* weights are 100
rounded:
  none: 0px
components:
  link-cta:
    type: button
    backgroundColor: transparent
    textColor: '#f2f2f2'
    rounded: 0px
    height: 48px
    typography: 14px / 100
    hover: 'fg #a0a0a0'
    use: Jetzt shoppen on the home page — a text-only call to action; hover fades the label to --fds-color-text-subtle. Focus is the browser's ring.
  button-search:
    type: button
    backgroundColor: transparent
    textColor: '#f2f2f2'
    rounded: 0px
    height: 48px
    typography: 14px / 100
    hover: 'fg #a0a0a0'
    use: 'Suchen in the header; the same fade to #a0a0a0 on hover, the browser''s ring on focus.'
  button-login:
    type: button
    backgroundColor: transparent
    textColor: '#f2f2f2'
    rounded: 0px
    height: 48px
    typography: 14px / 100
    hover: 'fg #a0a0a0'
    use: Einloggen in the header; same behaviour as search.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#f2f2f2'
    rounded: 0px
    typography: 14px / 100
    hover: transparent
    use: Damen in the main navigation. Hover changes nothing (confirmed with :hover matched); focus draws no indicator.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: HM Slussen
---

# H&M

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to H&M; reproduced for educational reference. Full prose: https://oh-my-design.kr/hm/design.md
