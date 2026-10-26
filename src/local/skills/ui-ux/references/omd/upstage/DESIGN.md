---
name: Upstage
colors:
  canvas: '#ffffff'
  ink: '#0a0d14'
  text: '#52525b'
  text-subtle: '#525866'
  action-violet: '#5b52ff'
  card-border: '#cdd0d5'
typography:
  marketing-display:
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.1
    use: Public home marketing hero only
  section-heading:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.15
    use: Public marketing section headings
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.6
    use: Public home and API-pricing body copy
  action:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Public CTA controls
rounded:
  action: 8px
  card: 8px
spacing:
  action-y: 12
  action-x: 18
  card: 32
  card-end: 96
components:
  api-pricing-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #cdd0d5'
    rounded: 8px
    padding: 32px 96px 32px 32px
    hover: 'border 1px #525866; shadow rgba(0,0,0,0.09) 0px 4px 6px 0px (on the card wrapper while its title link is hovered)'
    pressed: 'border 1px #525866; shadow rgba(0,0,0,0.09) 0px 4px 6px 0px, as on hover (the red on the pressed anchor is the Chromium default pressed-link colour, not a state)'
    focus: outline browser default ring (outline-style auto, offset 1px) on the title link, not brand; the card border and shadow do not change — measured 2026-09-29
    states: 'default captured 2026-07-13 (six cards); hover, pressed and keyboard focus measured 2026-09-29 through the Solar Pro 3 title link (Tab 16); in the 2026-09-29 DOM the card holding that title carries id solar-pro-4, where July cited #solar-pro-3; transition all 0s'
    use: API pricing model card observed on the public pricing surface
  public-primary-action:
    type: button
    backgroundColor: '#5b52ff'
    textColor: '#ffffff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 12px 18px
    size: 366px x 50px
    typography: 16px / 500 / Geist
    hover: transform matrix(1, 0, 0, 1, 19.2, 0) (translateX 19.2px) on the two arrow layers; fill, border and label unchanged
    pressed: transform matrix(1, 0, 0, 1, 19.2, 0) on the two arrow layers, as on hover
    focus: outline browser default ring (outline-style auto, offset 1px), not brand — measured 2026-09-29
    states: default captured 2026-07-13 (10 occurrences on home and pricing); hover, pressed and keyboard focus measured 2026-09-29 on Try in Playground (Tab 14); the fill never changes colour; transition all 0s
    use: Public filled conversion action (Try in Playground) inside the home product cards
    height: 50px
  public-secondary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5b52ff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 12px 18px
    size: 366px x 50px
    typography: 16px / 500 / Geist
    hover: 'bg #fafafa'
    pressed: 'bg #fafafa'
    focus: outline browser default ring (outline-style auto, offset 1px), not brand — measured 2026-09-29
    states: default captured 2026-07-13 (5 occurrences); hover, pressed and keyboard focus measured 2026-09-29 on the first Learn more (Tab 15); pressed equals hover; transition all 0s
    use: Public outlined conversion action (Learn more) paired with the filled action
  hero-primary-action:
    type: button
    backgroundColor: '#5b52ff'
    textColor: '#ffffff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 16px 32px
    size: 158px x 58px
    typography: 16px / 500 / Geist
    hover: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    focus: outline browser default ring (outline-style auto, offset 1px), not brand — measured 2026-09-29
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on Try Studio (Tab 12); transition all 0s
    use: Home hero filled action (Try Studio), the largest CTA on the page
  hero-secondary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5b52ff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 16px 32px
    size: 222px x 58px
    typography: 16px / 500 / Geist
    states: default captured 2026-07-13; not probed
    use: Home hero outlined action beside the filled hero action
  compact-secondary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#5b52ff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 10px 16px
    size: 345px x 43px
    typography: 14px / 500 / Geist
    states: default captured 2026-07-13 (4 occurrences on home and pricing); not probed
    use: Smaller outlined action (class is-secondary smaller)
  text-action:
    type: button
    backgroundColor: transparent
    textColor: '#5b52ff'
    rounded: 0px
    padding: 0px
    typography: 18px / 500 / Geist
    states: default captured 2026-07-13 (6 occurrences on home and pricing); not probed
    use: Violet text action at the top of the page (class button is-text, hidden below desktop)
  nav-contact-button:
    type: button
    backgroundColor: '#5b52ff'
    textColor: '#ffffff'
    border: '1px solid #5b52ff'
    rounded: 8px
    padding: 8px 16px
    size: 106px x 40px
    typography: 16px / 500 / Geist
    states: default captured 2026-07-13 (3 occurrences, one per captured page); not probed
    use: Small filled header action (class btn-contact)
  model-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#0a0d14'
    border: '1px solid #e2e4e9'
    rounded: 8px
    padding: 8px 16px
    size: 223px x 42px
    typography: 18px / 500 / Geist
    shadow: rgba(0,0,0,0.06) 0px 2px 3px 0px
    hover: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: current item (w--current, aria-selected true) captured 2026-07-13 with the same shadow, which the July declaration left out; hover, pressed and keyboard focus measured 2026-09-29 on Generative intelligence (Tab 12)
    use: Public API-pricing model tab, current item
  model-tab-inactive:
    type: tab
    backgroundColor: transparent
    textColor: '#525866'
    border: 1px solid transparent
    rounded: 10px
    padding: 8px 16px
    size: 220px x 42px
    typography: 18px / 500 / Geist
    hover: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: 'inactive item (aria-selected false, tabIndex -1) captured 2026-07-13; hover and pressed measured 2026-09-29 on Document intelligence; keyboard focus not measured: tabIndex -1 keeps it out of the Tab order, and arrow keys were not tested'
    use: 'Public API-pricing model tab, inactive item on the #f3f4f6 tab track'
  nav-products-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    padding: 12px 40px 12px 16px
    size: 116px x 48px
    typography: 15.04px / 400 / Geist
    hover: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels); the dropdown list is a sibling and was not compared — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    focus: 'outline 2px #4d65ff, offset 2px (authored; whether the rule is the site CSS or the Webflow platform stylesheet was not verified, so it is not a brand token) — measured 2026-09-29'
    states: hover, pressed and keyboard focus measured 2026-09-29 (Tab 4); aria-expanded false at rest; transition all 0.3s
    use: 'Header Products dropdown toggle (div role=button) over the dark #151727 navigation band'
  product-card:
    type: card
    backgroundColor: transparent
    textColor: '#52525b'
    border: '1px solid #cdd0d5'
    rounded: 8px
    padding: 24px
    size: 416px x 528px
    typography: 18px / 400 / Geist
    states: default captured 2026-07-13 (3 occurrences); not probed
    use: Home product card that holds the filled and outlined actions (div.basic_card-2)
fonts:
  roles:
    ui: Geist
    marketing-display: Espeak
---

# Upstage

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Upstage; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/upstage/DESIGN.md
