---
name: Vercel
colors:
  primary: '#171717'
  canvas: '#ffffff'
  foreground: '#171717'
  body: '#4d4d4d'
  muted: '#666666'
  border: '#ebebeb'
  surface: '#fafafa'
typography:
  hero:
    fontSize: 64px
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-3.84px'
    use: Current public hero
  section:
    fontSize: 56px
    fontWeight: 450
    lineHeight: 1
    letterSpacing: '-3.36px'
    use: Repeated current public section heading
  feature:
    fontSize: 30px
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: '-1.5px'
    use: Current public feature statement
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.96px'
    use: Current public technical card title
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Current public and Geist explanatory body
  ui:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Current navigation, lists, and compact controls
  mono:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Current technical labels and code-adjacent content
rounded:
  compact: 4px
  control: 6px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 24
  xl: 32
components:
  header-link:
    type: button
    backgroundColor: transparent
    textColor: '#4d4d4d'
    rounded: 0px
    height: 32px
    typography: 14px / 400
    states: default captured; current baseline run did not promote hover or pressed values
    use: Current public header navigation link
  geist-secondary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171717'
    border: '0 0 0 1px #ebebeb'
    rounded: 6px
    padding: 0 10px
    height: 36px
    typography: 14px / 500
    states: default official Geist example captured
    use: Official Geist secondary action example
  geist-icon-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171717'
    border: '0 0 0 1px #ebebeb'
    rounded: 6px
    size: 36px
    states: default official Geist example captured
    use: Official Geist compact icon-button example
  geist-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#171717'
    border: 'adjacent control ring #ebebeb'
    rounded: 0px
    padding: 0 12px
    height: 36px
    typography: 14px / 400
    states: default official Geist example captured; no focus value promoted
    use: Official Geist compact input example
  geist-radio:
    type: toggle
    backgroundColor: transparent
    textColor: '#4d4d4d'
    rounded: 9999px
    size: 32px
    states: unchecked observed
    use: Official Geist radio example
  geist-example-card:
    type: card
    backgroundColor: transparent
    textColor: '#171717'
    border: 'shared #ebebeb grid boundary'
    rounded: 0px
    padding: 32px
    gap: 24px
    use: Official Geist component-example card
fonts:
  roles:
    ui: Geist
    mono: Geist Mono
---

# Vercel

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Vercel; reproduced for educational reference. Full prose: https://oh-my-design.kr/vercel/design.md
