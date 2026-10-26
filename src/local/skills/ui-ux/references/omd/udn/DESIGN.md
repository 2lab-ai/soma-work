---
name: 聯合新聞網
colors:
  canvas: '#fafafa'
  foreground: '#000000'
  muted: '#777777'
  primary: '#2f76aa'
  action-muted: '#c7c7c7'
  accent: '#ee5103'
typography:
  feature-headline:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 48px
    letterSpacing: 1px
    use: Observed white home h2 on editorial feature blocks; not a universal display scale.
  body:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 18.4px
    letterSpacing: 1px
    use: Observed home body baseline only.
  control:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 18.75px
    use: Observed real load-more button on the politics and finance category surfaces.
rounded:
  none: 0px
  control: 3px
spacing:
  xs: 2
  sm: 5
  md: 8
  lg: 10
components:
  load-more-button:
    type: button
    backgroundColor: '#c7c7c7'
    textColor: '#ffffff'
    rounded: 0px 0px 3px 3px
    padding: 6px 40px
    height: 31px
    typography: 15px / 400 / 18.75px / Noto Sans TC
    states: Observed default only; no hover, focus, pressed, or disabled value was captured.
    use: Real button at politics selector surface-2::[data-omd-capture=90], repeated on the finance category surface.
    focus: no visible change (measured 2026-10-16) on :focus-visible
  newsletter-email-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 3px 0px 0px 3px
    padding: 8px 10px
    height: 31px
    typography: 13px / 400 / 14.95px / Noto Sans TC
    states: Default geometry is observed; form-error interaction targets were captured, but the packet records no distinct error-style value. No hover, focus, pressed, or disabled value was captured.
    use: Email input at home selector home::[data-omd-capture=331], also present on the two category surfaces.
fonts:
  roles:
    ui: Noto Sans TC
---

# 聯合新聞網

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 聯合新聞網; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/udn/DESIGN.md
