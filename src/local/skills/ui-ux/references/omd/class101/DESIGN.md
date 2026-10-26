---
name: Class101
colors:
  brand: '#FF5D00'
  canvas: '#FFFFFF'
  foreground: '#0C0C0C'
  foreground-strong: '#000000'
  muted: '#373737'
typography:
  display:
    fontSize: 40px
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: '-1.12px'
    use: Home display heading
  page-title:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.29
    letterSpacing: '-0.616px'
    use: Observed h1
  section-heading:
    fontSize: 26px
    fontWeight: 700
    lineHeight: 1.38
    use: Observed h2
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.67
    use: Observed reading text
  control:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Computed on the home control and tab roots, which carry the inherited body type; their visible labels were not sampled separately (corrected 2026-09-30)
rounded:
  sm: 4px
  md: 8px
  lg: 12px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 24
  xl: 36
components:
  legal-list-item:
    type: listItem
    backgroundColor: transparent
    textColor: '#0C0C0C'
    padding: 0px 0px 0px 24px
    typography: 16px / 400 / Pretendard Variable
    use: Observed official privacy-document list item only
  legal-document-tab:
    type: tab
    backgroundColor: transparent
    textColor: rgba(55, 55, 55, 0.8)
    border: 1px transparent
    rounded: 0px
    padding: 12px 0px 10px
    height: 45px
    typography: 18px / 700 / Pretendard Variable
    selected: 'border 1px #0c0c0c (bottom side), fg #0c0c0c'
    states: 'five tabs per legal page; the one with aria-selected="true" (giftcard capture 2, privacy capture 1, compared as a string) computes a #0c0c0c bottom border and a #0c0c0c label, and the four with "false" keep a transparent 1px bottom border and a rgba(55, 55, 55, 0.8) label. Both pages agree. No state frame'
    use: 'Legal-document tab (button role=tab) at surface-2::[data-omd-capture="0"]; the root computes #000000 / 16px / 400 and the label is its child h3 (line height 22px, tracking -0.288px). Document chrome, not product navigation'
  home-nav-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    size: 108px x 38px
    states: eleven captured at rest on home; no state frame
    use: 'Home category button (css-bzjpx5) at home::[data-omd-capture="6"]. The root computes #000000 / 16px / 400 with line height normal, and no child label was captured, so no label style is declared'
  home-outlined-button:
    type: button
    backgroundColor: transparent
    border: 1px rgba(255, 255, 255, 0.298)
    rounded: 12px
    padding: 14px 13px
    height: 50px
    states: captured at rest on home (captures 28 and 86, 240 px wide; capture 95 has the same outline at 121 px); no state frame
    use: 'Home outlined button (css-67lr3i) at home::[data-omd-capture="28"]. The root computes #000000 / 16px / 400 and no child label was captured, so no label style is declared'
  home-tab:
    type: tab
    backgroundColor: transparent
    rounded: 0px
    size: 97px x 44px
    states: ten captured on home, every one aria-selected="false" (compared as a string), so no selected style is declared; no state frame
    use: Home tab (div role=tab, css-12n7wd0) at home::[data-omd-capture="7"]. Its colour and type equal the inherited body text (#000000, 16px / 400 / 16px), so it is a container and no label style is declared
  tinted-button:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.03)
    rounded: 8px
    padding: 10px
    height: 38px
    states: 'captured at rest twice on home: header link capture 5 (62 px wide) and footer button capture 96 (74 px wide); no state frame'
    use: 'Tinted compact button at home::[data-omd-capture="5"]; the root computes the inherited #000000 / 16px / 400 and no child label was captured'
  content-card:
    type: card
    textColor: '#ffffff'
    size: 240px x 147px
    typography: 18px / 700 / Pretendard Variable
    states: 52 captured at rest on home; no state frame
    use: Home content card (a.css-1lalw83) at home::[data-omd-capture="30"]; text colour and font are the child h3[data-testid="title"] (208 px wide, line height 22px, tracking -0.288px). The anchor computes no fill and 0px radius and its image was not captured, so no fill or radius is declared
  showcase-list-button:
    type: button
    backgroundColor: transparent
    size: 300px x 134px
    typography: 20px / 700 / Pretendard Variable
    states: 'four captured at rest on home (captures 82-85). One title computes #0c0c0c and the other three rgba(55, 55, 55, 0.8); no aria-selected is recorded and nothing else in the capture names the active one, so neither a text colour nor a selected style is declared. No state frame'
    use: Home showcase list button (css-vf38px) at home::[data-omd-capture="82"]; the font is the child h3[data-testid="title"] (260 px wide, line height 26px, tracking -0.36px)
  header-category-button:
    type: button
    backgroundColor: transparent
    textColor: rgba(55, 55, 55, 0.8)
    size: 87px x 22px
    typography: 18px / 500 / Pretendard Variable
    states: one captured at rest on home; no state frame
    use: Home header button (css-1hvtp3b) at home::[data-omd-capture="2"]; text colour and font are the child h3[data-testid="title"] (five characters, matched by top offset and text length; line height 22px, tracking -0.288px)
  header-accent-link:
    type: button
    backgroundColor: transparent
    textColor: '#ff5d00'
    size: 179px x 26px
    typography: 20px / 700 / Pretendard Variable
    states: one captured at rest on home; no state frame
    use: Home header link (a.css-b70msd) at home::[data-omd-capture="1"]; text colour and font are its two-character child h3[data-testid="title"] (line height 26px, tracking -0.36px), one of the three orange title samples
  list-row-button:
    type: button
    backgroundColor: transparent
    size: 600px x 62px
    states: five captured at rest on home; no state frame
    use: 'Home list row button (css-1hvtp3b) at home::[data-omd-capture="88"]; the root computes the inherited #000000 / 16px / 400 and no child label was captured'
fonts:
  roles:
    sans: Pretendard Variable
---

# Class101

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Class101; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/class101/DESIGN.md
