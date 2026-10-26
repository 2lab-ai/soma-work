---
name: Moreh
colors:
  primary: '#ff5700'
  on-primary: '#ffffff'
  primary-hover: '#f34600'
  ink: '#050403'
  canvas: '#ffffff'
  inverse: '#050403'
  footer: '#1c1a18'
  on-inverse: '#f8f7f4'
  on-inverse-muted: '#a09e9a'
  muted: '#65635f'
  subtle: '#888682'
  link: '#dd4300'
  link-on-dark: '#ff793e'
  hairline: '#dfdeda'
  outline: '#d2d1cd'
  inverse-border: '#2a2926'
typography:
  display-hero:
    fontSize: 93.6px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-3.744px'
    use: 'Home hero headline (h1.text-display-lg), #f8f7f4 on the #050403 band, English and Korean editions'
  display:
    fontSize: 72px
    fontWeight: 600
    lineHeight: 1.04
    letterSpacing: '-2.52px'
    use: Product hero title on the MoAI Inference Framework page (h1.hero-title)
  section:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: '-1px'
    use: Section titles (h2.sh-title)
  lead:
    fontSize: 24px
    fontWeight: 500
    lineHeight: 1.33
    use: Subtitle under the product hero (p.text-2xl)
  card-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.18px'
    use: Feature-card headings (h3.fc-title); news-row titles use the same size on a 25.2px line
  body-lg:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.6
    use: Hero sub-copy (p.text-body-lg)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Page body
  section-desc:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.65
    use: Descriptions under section titles (p.sh-desc)
  card-desc:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    use: Feature-card descriptions (p.fc-desc)
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Header menu
  button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.5
    use: Primary and ghost action labels
  small:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
    use: News summaries and footer links (text-body-sm); inline links use 13px at 500
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Footer copyright line (text-caption)
  eyebrow:
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.6
    letterSpacing: 1.32px
    use: Uppercase JetBrains Mono eyebrows (p.mono-eyebrow)
  mono-label:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 1.32px
    use: Uppercase JetBrains Mono footer pills
rounded:
  none: 0px
  sm: 6px
spacing:
  button-x: 18
  card: 28
  row-y: 24
  nav-y: 8
  pill-y: 6
  pill-x: 12
components:
  primary-button:
    type: button
    backgroundColor: '#ff5700'
    textColor: '#ffffff'
    border: 1px solid transparent
    rounded: 6px
    padding: 0px 18px
    height: 40px
    typography: 14px / 500 / 21px Inter
    hover: 'bg #f34600; the arrow shifts 2px right (settled probe frame after a 120ms transition)'
    pressed: 'bg #f34600, the same settled frame as hover (probe)'
    use: Request Demo on moreh.io and the MoAI Inference Framework page, and the same action on moreh.io/ko/ (captures 8 on all three pages)
    focus: outline oklch(0.7 0.2 40 / 0.35) solid 2px on :focus-visible
  ghost-on-dark-button:
    type: button
    backgroundColor: transparent
    textColor: '#f8f7f4'
    border: 1px solid rgba(255, 255, 255, 0.25)
    rounded: 6px
    padding: 0px 18px
    height: 40px
    typography: 14px / 500 / 21px Inter
    hover: bg rgba(255, 255, 255, 0.06), border 1px solid rgba(255, 255, 255, 0.4) (settled probe frame)
    pressed: the same values as hover (probe)
    use: View Benchmarks beside the primary action on the home hero band
  ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#050403'
    border: '1px solid #d2d1cd'
    rounded: 6px
    padding: 0px 18px
    height: 40px
    typography: 14px / 500 / 21px Inter
    states: rest only; the bundle hover and pressed frames were mid-transition, so no state is declared
    use: Secondary action beside the primary on the MoAI Inference Framework hero
  text-link:
    type: button
    textColor: '#dd4300'
    typography: 13px / 500 / 20.15px Inter
    states: rest only; no settled state frame
    use: Inline arrow links on white (four on each home, plus a 14px / 500 variant)
  text-link-on-dark:
    type: button
    textColor: '#ff793e'
    typography: 14px / 500 / 21px Inter
    states: rest only
    use: Inline link in the dark section of the MoAI Inference Framework page
  nav-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#050403'
    padding: 8px 0px
    height: 37px
    typography: 14px / 400 / 21px Inter
    states: rest only; bundle frames drift by one colour unit, which is not a design value
    use: 'Header menu: Products, Solutions, Performance, Resources, Careers, Company'
  language-switcher:
    type: button
    backgroundColor: transparent
    textColor: '#65635f'
    padding: 8px 0px
    height: 36px
    typography: 13px / 400 / 19.5px Inter
    states: rest only
    use: Language switcher at the right of the header (EN on moreh.io, KO on moreh.io/ko/)
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #dfdeda'
    rounded: 6px
    padding: 28px
    width: 348px
    states: rest; the linked cards on the Inference Framework page start a border and shadow transition on hover, but no settled frame was captured, so the hover is unmeasured
    use: Feature cards, three to a row, on all three pages
  news-row:
    type: card
    border: 'bottom 1px solid #dfdeda'
    padding: 24px 0px
    width: 1076px
    use: 'Newsroom and blog rows on the home: 18px / 600 title, 13px #65635f summary'
  footer-pill:
    type: badge
    backgroundColor: transparent
    textColor: '#a09e9a'
    border: '1px solid #2a2926'
    rounded: 6px
    padding: 6px 12px
    height: 31px
    typography: 11px / 400 / 16.5px JetBrains Mono, uppercase, letter-spacing 1.32px
    hover: 'fg #f8f7f4 (settled probe frame after a 150ms transition)'
    use: 'Privacy Policy and Terms of Use on the #1c1a18 footer'
fonts:
  roles:
    sans: Inter
    mono: JetBrains Mono
---

# Moreh

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Moreh; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/moreh/DESIGN.md
