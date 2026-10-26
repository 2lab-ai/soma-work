---
name: ProtoPie
colors:
  primary: '#8169ff'
  on-primary: '#ffffff'
  primary-hover: '#5b3ee0'
  annotation: '#6d4ff0'
  ink: '#181818'
  body: '#373737'
  muted: '#474747'
  faint: '#999999'
  surface: '#fafafa'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 62px
    fontWeight: 700
    lineHeight: 1.29
    use: 'Hero headline on home and /discover, Figtree, 80px line, in #181818'
  section:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.3
    use: 'Section headlines on home and /discover, Figtree, 62.4px line, in #181818'
  subsection:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Plan names and comparison headings on /plans, Figtree, 50.4px line, in #181818'
  card-title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Resource card and feature headings, Figtree, 39.2px line, in #181818 (white on the dark band)'
  plan-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Violet plan headers (#8169ff) and ink comparison-row titles on /plans, Figtree, 33.6px line
  lead:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.4
    use: Hero lead on home (#181818) and /discover (#373737), Inter, 33.6px line
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Header navigation labels (Solutions, Resources, Features, Pricing, Download), Figtree, 22.4px line, in #181818'
  button-lg:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    use: Labels of the 53px buttons (Get started for free, Read Comparison), Inter, 25.2px line
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.4
    use: Header button labels (Book a Demo, Start for Free) and inline links, Inter, 22.4px line
  button-sm:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    use: Labels of the 32px buttons (Learn More, Request Demo), Inter, 19.6px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Resource card descriptions and feature copy, Inter, 24px line, in #474747'
  body-sm:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: 'Footer text, Inter, 19.6px line, in #373737'
  caption:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.4
    use: 'Prototype tags on /discover, Inter, 16.8px line, in #474747'
  eyebrow:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.11px'
    use: 'Industry tab labels on the dark band, Figtree, 13.2px line, in #ffffff'
  annotation:
    fontSize: 48px
    fontWeight: 400
    lineHeight: 0.79
    letterSpacing: 0.48px
    use: 'Handwritten annotations beside the feature rows on home, Palmer Lake Print Regular, 38px line, in #6d4ff0'
rounded:
  button: 4px
  card: 12px
  panel: 16px
  chip: 100px
spacing:
  cta-y: 14
  cta-x: 16
  header-cta-y: 12
  sm-y: 6
  nav-y: 4
  nav-x: 20
  card-y: 25
  card-x: 30
components:
  primary-button:
    type: button
    backgroundColor: '#8169ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 14px 16px
    height: 53px
    typography: 18px / 600 / 25.2px Inter
    hover: 'bg #5b3ee0'
    pressed: 'bg #5b3ee0'
    states: 'probe: hover and pressed settle on #5b3ee0 (transition all 0s) on Get started for free and Subscribe Now; focus draws only the browser default ring'
    use: Get started for free in the home hero (198 x 53), Read Comparison, Explore Gallery, Get Started for Free on /discover and Subscribe Now on /plans
  header-button:
    type: button
    backgroundColor: '#8169ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 12px 16px
    height: 40px
    typography: 16px / 600 / 22.4px Inter
    hover: 'bg #5b3ee0'
    pressed: 'bg #5b3ee0'
    states: 'probe: hover and pressed settle on #5b3ee0; focus (Tab #5) draws only the browser default ring'
    use: Book a Demo at the right end of the header on all three pages (134 x 40); View All Features and Get Started (46px) share the 12px 16px padding
  small-button:
    type: button
    backgroundColor: '#8169ff'
    textColor: '#ffffff'
    rounded: 4px
    padding: 6px 16px
    height: 32px
    typography: 14px / 600 / 19.6px Inter
    states: 'rest only: this size was not probed, and its bundle frames (#7f66fd, #8068fe) are Framer transition frames, so no hover or pressed value is declared'
    use: Request Demo on the dark industry band of home; Get Started, Subscribe and Chat with Us under the /plans comparison
  text-button:
    type: button
    backgroundColor: transparent
    textColor: '#8169ff'
    rounded: 4px
    height: 40px
    typography: 16px / 600 / 22.4px Inter
    hover: 'label #5b3ee0'
    pressed: 'label #5b3ee0'
    states: 'probe: the label settles on #5b3ee0; focus (Tab #4) draws only the browser default ring'
    use: Start for Free beside Book a Demo in the header (102 x 40)
  ghost-button:
    type: button
    backgroundColor: transparent
    textColor: '#8169ff'
    rounded: 4px
    padding: 14px 16px
    height: 53px
    typography: 18px / 600 / 25.2px Inter
    hover: 'bg #8169ff, label #ffffff'
    pressed: 'bg #8169ff, label #ffffff'
    states: 'probe on /plans: the button fills violet on hover and pressed; focus draws only the browser default ring'
    use: View All Prototypes and Learn More on /discover (202 x 53, 131 x 53) and Get Started on the /plans Free card (268 x 53); no border is drawn at rest
  white-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#8169ff'
    rounded: 4px
    padding: 14px 16px
    height: 53px
    hover: 'label #5b3ee0'
    pressed: 'label #5b3ee0'
    states: 'probe on /plans: the label settles on #5b3ee0; focus draws only the browser default ring'
    use: Learn More on a /plans card (268 x 53)
  nav-item:
    type: tab
    textColor: '#181818'
    padding: 4px 20px
    height: 60px
    typography: 16px / 700 / 22.4px Figtree
    hover: 'label #5b3ee0'
    pressed: 'label #5b3ee0'
    states: 'probe on Pricing: the label turns #5b3ee0 on hover and pressed; focus (Tab #2) draws only the browser default ring; no selected variant was observed'
    use: Solutions, Resources, Features, Pricing and Download in the sticky 60px header
  industry-tab:
    type: tab
    backgroundColor: rgba(122, 100, 255, 0.35)
    rounded: 4px
    size: 106px x 81px
    selected: 'bg #8169ff'
    hover: bg rgba(122, 100, 255, 0.5)
    pressed: bg rgba(122, 100, 255, 0.5)
    states: 'probe: unselected tabs deepen to 0.5 alpha on hover and pressed; the selected tab shows no change; focus draws only the browser default ring'
    use: Automotive, Website, Mobile & Tablet, TV & Productions, Smartwatches and Game tabs on the dark industry band of home
  filter-chip:
    type: tab
    backgroundColor: '#ffffff'
    rounded: 100px
    padding: 10px 24px
    height: 44px
    selected: 'bg #8169ff with a 1px solid #8169ff ::after border'
    hover: opacity 0.8
    pressed: opacity 0.8
    states: 'probe on /plans: unselected chips fade to opacity 0.8 on hover and pressed; the selected chip shows no change; focus draws only the browser default ring'
    use: Feature filters (All, Essentials, Collaboration, Security, Support, Add-ons) above the /plans comparison
  resource-card:
    type: card
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#181818'
    rounded: 12px
    shadow: rgba(0, 0, 0, 0.08) 0px 3px 12px 0px, rgba(0, 0, 0, 0.2) 0px 0px 2px 0px
    size: 384px x 386px
    hover: shadow rgba(0, 0, 0, 0.08) 0px 3px 12px 0px, rgba(0, 0, 0, 0.08) 0px 0px 6px 3px
    use: ProtoPie School, Community and Blog cards on home (captures 23 to 25)
  prototype-card:
    type: card
    backgroundColor: '#fafafa'
    rounded: 16px
    padding: 25px 30px 33px
    size: 373px x 371px
    use: Featured prototype cards on /discover
fonts:
  roles:
    display: Figtree
    body: Inter
    annotation: Palmer Lake Print Regular
---

# ProtoPie

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to ProtoPie; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/protopie/DESIGN.md
