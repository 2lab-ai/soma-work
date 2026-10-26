---
name: Bithumb
colors:
  primary: '#1C2028'
  brand: '#543E35'
  canvas: '#1C2028'
  on-primary: '#FFFFFF'
  cta-text: '#4F3327'
  cta-surface-text: '#F8F9FA'
  hairline: '#B6ABA1'
  muted: '#707882'
  muted-2: '#93989E'
  surface-text: '#F8F9FA'
  foreground: '#FFFFFF'
  price-up: '#E15241'
  price-down: '#4880EE'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    use: Workhorse readable content in a packed layout
  control:
    fontSize: 13px
    fontWeight: 500
    use: Buttons, chips, interactive labels
  micro-label:
    fontSize: 12px
    fontWeight: 400
    use: Dense data annotations coexisting with numbers
  chip-active:
    fontSize: 13px
    fontWeight: 600
    use: Active filter chip label
  cta:
    fontSize: 18px
    fontWeight: 500
    use: Primary exchange CTA label
rounded:
  sm: 4px
  md: 8px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#1C2028'
    textColor: '#FFFFFF'
    rounded: 4px
    height: 32px
    typography: 13px / 500
    use: Signup — structural top-chrome action
  cta-filled:
    type: button
    backgroundColor: '#543E35'
    textColor: '#F8F9FA'
    rounded: 4px
    height: 56px
    typography: 18px / 500
    use: Primary exchange CTA — single warmest action
  cta-outline:
    type: button
    backgroundColor: transparent
    textColor: '#4F3327'
    border: '1px solid #B6ABA1'
    rounded: 4px
    height: 56px
    use: Secondary action paired with filled bronze CTA
  chip-active:
    type: badge
    backgroundColor: '#1C2028'
    textColor: '#FFFFFF'
    rounded: 8px
    height: 36px
    typography: 13px / 600
    use: Selected filter chip
  chip-inactive:
    type: badge
    backgroundColor: transparent
    textColor: '#707882'
    border: 1px solid rgba(28,32,40,0.1)
    rounded: 8px
    use: Unselected filter chip
fonts:
  roles:
    sans: Bithumb Trading Sans
    mono: Bithumb Trading Sans
---

# Bithumb

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Bithumb; reproduced for educational reference. Full prose: https://oh-my-design.kr/bithumb/design.md
