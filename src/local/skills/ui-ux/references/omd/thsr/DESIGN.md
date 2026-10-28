---
name: Taiwan High Speed Rail
colors:
  primary: '#ca4f0f'
  canvas: '#ffffff'
  foreground: '#333333'
  body: '#666666'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    use: Observed on supplied public article list items; do not generalize to the T-EX app or unobserved purchase flows.
  section-heading:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 42px
    letterSpacing: 5px
    use: Observed on the supplied public home heading only.
rounded:
  square: 0px
  action: 3px
  dialog: 5px
spacing:
  control-vertical: 12
  control-horizontal: 20
  dialog-inset: 20
components:
  public-booking-action:
    type: button
    backgroundColor: '#ca4f0f'
    textColor: '#ffffff'
    rounded: 3px
    padding: 12px 20px
    height: 53px
    typography: 16px / 400 / Noto Sans TC
    states: Default only; the supplied capture contains zero interaction records, so no hover, focus, pressed, disabled, or transition value is observed.
    use: Public home booking control at home::[data-omd-capture="46"]; static geometry only.
fonts:
  roles:
    ui: Noto Sans TC
---

# Taiwan High Speed Rail

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Taiwan High Speed Rail; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/thsr/DESIGN.md
