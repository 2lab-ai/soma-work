---
name: The Guardian
colors:
  primary: '#052962'
  brand-dark: '#041f4a'
  brand-deepest: '#001536'
  brand-bright: '#0077b6'
  brand-muted: '#506991'
  brand-pale: '#c1d8fc'
  link: '#c70000'
  highlight: '#ffe500'
  foreground: '#121212'
  text-secondary: '#707070'
  news-border: '#333333'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  surface-muted: '#ededed'
  line: '#dcdcdc'
  line-strong: '#bababa'
  opinion: '#c74600'
  opinion-bright: '#e05e00'
  culture: '#866d50'
  lifestyle: '#bb3b80'
  sport-deep: '#005689'
typography:
  nav:
    fontSize: 17px
    use: pillar navigation and utility links, 700
rounded:
  sm: 12px
  lg: 40px
  pill: 1000px
components:
  link-pillar:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 64px
    padding: 4px 0 4px 4px
    typography: 17px / 700
    hover: transparent
    focus: 'ring 0 0 0 3px #0077b6'
    use: Pillar and utility links on the navy masthead (News, Opinion, Sport, Sign in). Hover changes nothing; focus draws a 3px brand-blue ring as a box-shadow.
  button-masthead:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    hover: transparent
    focus: 'ring 0 0 0 3px #0077b6'
    use: 'Masthead buttons — Show more and the Edition switcher. The same: no hover change, the same 3px #0077b6 ring on focus.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Guardian Headline
    sans: Guardian Text Sans
---

# The Guardian

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to The Guardian; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/theguardian/DESIGN.md
