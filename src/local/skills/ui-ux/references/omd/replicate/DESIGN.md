---
name: Replicate
colors:
  dark: '#202020'
  red: '#ea2804'
  secondary-red: '#dd4425'
  status-green: '#2b9a66'
  github-dark: '#24292e'
  white: '#ffffff'
  near-white: '#fcfcfc'
  medium-gray: '#646464'
  warm-gray: '#4e4e4e'
  mid-silver: '#8d8d8d'
  light-silver: '#bbbbbb'
  black: '#000000'
typography:
  display-mega:
    fontSize: 128px
    fontWeight: 700
    lineHeight: 1
    use: Closing manifesto (rb-freigeist-neue)
  display-hero:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-1.8px'
    use: Hero headline (rb-freigeist-neue)
  section:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    use: Feature section titles (rb-freigeist-neue)
  subheading:
    fontSize: 30px
    fontWeight: 600
    lineHeight: 1.2
    use: Card headings (rb-freigeist-neue)
  body-lg:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.4
    use: Intro paragraphs
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard text, buttons
  caption:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Metadata, descriptions
  code:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Code snippets (jetbrains-mono)
rounded:
  sm: 9999px
  md: 9999px
  lg: 9999px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 96
components:
  button-dark:
    type: button
    backgroundColor: '#202020'
    textColor: '#fcfcfc'
    rounded: 9999px
    padding: 0 4px
    use: Maximum-emphasis dark pill on light surface
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#202020'
    rounded: 9999px
    use: 'Outlined pill, 1px #202020 border, secondary actions'
  button-glass:
    type: button
    backgroundColor: transparent
    textColor: '#202020'
    rounded: 9999px
    padding: 6px 56px 6px 28px
    use: 'Frosted glass search/input button, 1px #bbbbbb outline'
  card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#202020'
    rounded: 9999px
    use: 'Container, 1px #202020 border; #ea2804 border when featured'
  input:
    type: input
    backgroundColor: transparent
    textColor: '#202020'
    rounded: 9999px
    padding: 6px 56px 6px 28px
    use: Frosted glass search-style input
  status-badge:
    type: badge
    backgroundColor: '#2b9a66'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 14/400
    use: Operational/running status indicator
  code-block:
    type: card
    backgroundColor: '#24292e'
    textColor: '#ffffff'
    rounded: 9999px
    typography: 14/400
    use: Code block (jetbrains-mono)
fonts:
  roles:
    sans: basier-square
    mono: jetbrains-mono
---

# Replicate

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Replicate; reproduced for educational reference. Full prose: https://oh-my-design.kr/replicate/design.md
