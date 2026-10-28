---
name: FuriosaAI
colors:
  primary: '#e21500'
  canvas: '#ffffff'
  ink: '#0b0b0b'
  on-primary: '#ffffff'
  on-primary-soft: '#e1e1e1'
  notice-title: '#111111'
  form-canvas: '#000000'
  form-muted: '#87909e'
  form-ink: '#30343b'
  form-border: '#c0d0de'
  error: '#942e1e'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Body text on furiosa.ai
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.6
    use: Header navigation on furiosa.ai
  button:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Header action label (Talk to sales)
  form-display:
    fontSize: 47px
    fontWeight: 400
    lineHeight: 1.11
    use: Furiosa Access Program headline (h1)
  form-heading:
    fontSize: 30px
    fontWeight: 400
    lineHeight: 1.35
    use: Furiosa Access Program section heading (h2)
  form-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.45
    use: Furiosa Access Program body text
  notice-title:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.35
    use: Notice modal title
  notice-body:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.55
    use: Notice modal body text
  notice-button:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.6
    use: Notice modal Close label
  submit:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Furiosa Access Program submit label
rounded:
  xs: 1px
  sm: 2px
  md: 5px
  lg: 10px
  xl: 12px
spacing:
  nav-y: 8
  nav-x: 12
  cta-x: 12
  field-x: 15
  submit-x: 64
  notice-card: 18
components:
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    padding: 8px 12px
    height: 38px
    typography: 14px / 400 / 22.4px ABC Favorit
    states: rest only on home and About; no state frame
    use: Header links (Developers, Blog) over the dark hero at home::[data-omd-capture="1"], 95 x 38; Products and Company open menus that were not captured
  header-cta:
    type: button
    backgroundColor: '#e21500'
    textColor: '#e1e1e1'
    border: 1px solid transparent
    rounded: 1px
    padding: 8px 12px
    height: 38px
    typography: 14px / 400 / 20px ABC Favorit
    states: rest on home and About; no state frame
    use: Talk to sales at the right of the header (div.button wrapping the link at home::[data-omd-capture="3"]), 126 x 38
    pressed: 'bg #b51100 (+2 nested-layer changes) (:hover + :active)'
  notice-modal:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 18px
    size: 420px x 374px
    shadow: rgba(0, 0, 0, 0.18) 0px 18px 50px 0px
    use: 'Corporate notice card (cy-popup__card) that furiosa.ai opens on arrival, two stacked on home and About (a recruitment-phishing warning and a new-share issuance notice); title 14px / 700 / 18.9px #111111, body 12px / 400 / 18.6px at rgba(0, 0, 0, 0.75)'
  notice-close-button:
    type: button
    backgroundColor: '#e21500'
    textColor: '#ffffff'
    rounded: 10px
    padding: 10px 12px
    height: 39px
    typography: 12px / 600 / 19.2px ABC Favorit
    states: rest on four instances (two modals each on home and About); no state frame
    use: Close button across the foot of each notice card at home::[data-omd-capture="5"], 384 x 39, under a 다시 보지 않기 / Don't show again checkbox
  access-form-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#30343b'
    border: '1px solid #c0d0de'
    rounded: 5px
    padding: 0px 15px
    height: 56px
    typography: 16px / 400 / 18.9px Favorit
    error: 'fg #942e1e, border 1px solid #942e1e'
    states: rest and error; all eight required fields read the same error value after the collector focused them in turn and called reportValidity() on the first; nothing was submitted; focus is not declared from the capture
    use: Field of the Furiosa Access Program form (HubSpot-hosted, lp.furiosa.ai) at surface-2::[data-omd-capture="0"], 426 x 56 half width or 864 x 56 full width; selects share the style
  access-form-submit:
    type: button
    backgroundColor: '#e21500'
    textColor: '#ffffff'
    rounded: 2px
    padding: 0px 64px
    height: 56px
    typography: 16px / 700 / 16px Favorit
    states: rest captured; the pressed frame adds only transparent zero-size shadows and the focus frame shadows at alpha 0.024, both transition frames, so neither is declared
    use: Submit button of the Furiosa Access Program form (input.hs-button.primary) at surface-2::[data-omd-capture="9"], 181 x 56; never used to submit
fonts:
  roles:
    sans: ABC Favorit
    form: Favorit
---

# FuriosaAI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to FuriosaAI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/furiosaai/DESIGN.md
