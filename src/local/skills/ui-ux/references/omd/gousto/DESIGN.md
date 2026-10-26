---
name: Gousto
colors:
  primary: '#615cff'
  primary-highlight: '#412dee'
  primary-surface: '#eae9ff'
  foreground: '#516272'
  text-strong: '#373a3c'
  text-black: '#000000'
  surface: '#f4f7fa'
  surface-dark: '#333d47'
  surface-darkest: '#11161b'
  border: '#ced4d9'
  canvas: '#ffffff'
  red: '#ff0032'
  green: '#01a92b'
  grey: '#7d7e7f'
  link-blue: '#0275d8'
typography:
  body:
    fontSize: 18px
    use: '--fontStyle-BodyL (18px/27px), AxiformaBook 400'
  button:
    fontSize: 18px
    use: primary CTA label, AxiformaBook 400
  nav:
    fontSize: 14px
    use: top-nav links Recipe boxes / Box prices, Axiforma 700
  login:
    fontSize: 13px
    use: Login ghost button, AxiformaBook 400
rounded:
  sm: 3px
  lg: 8px
  pill: 64px
components:
  button-primary:
    type: button
    backgroundColor: '#615cff'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 10px 24px
    typography: 18px / 400
    hover: '#412dee'
    pressed: 'shadow 0 0 0 3px #412dee'
    focus: 'ring inset 0 0 0 1px #ffffff, outline 2px solid #412dee'
    use: '"Get started" hero CTA. Renders at 8px radius though --Gousto-button-border-radius declares 3px. Hover and pressed both deepen to Secondary-600 #412dee; focus adds a white inset ring plus a 2px solid #412dee outline.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 3px
    height: 20px
    typography: 14px / 700
    hover: '#ffffff'
    pressed: 'shadow 0 0 0 3px #412dee'
    focus: 'shadow 0 0 0 3px #412dee'
    use: '"Recipe boxes" and "Box prices" top-nav links on the red header. Hover shows no visible change (confirmed); pressed and focus both draw the same #412dee ring even on the red background.'
  link-nav-dropdown:
    type: button
    textColor: '#ffffff'
    height: 24px
    typography: 18px / 400
    pressed: 'ring inset 0 0 0 1px #ffffff, outline 2px solid #412dee'
    focus: 'ring inset 0 0 0 1px #ffffff, outline 2px solid #412dee'
    use: '"How it works" dropdown trigger. Hover not measured. Pressed and focus match the primary CTA''s ring treatment.'
  link-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#373a3c'
    rounded: 0px
    height: 35px
    typography: 13px / 400
    hover: transparent
    pressed: transparent
    use: '"Login" top-right ghost/text link. No hover or pressed change measured. Its focus is the browser default outline (auto), not a brand ring — the only control on the page without one.'
  card-link:
    type: button
    textColor: '#615cff'
    border: 'top/left/right #615cff, bottom #c0c5c9 (asymmetric)'
    height: 402px
    hover: 'fg #3e3ac2'
    pressed: 'fg #3e3ac2'
    use: 'Recipe cards on /cookbook/recipes (e.g. "Simply Perfect Beef Spag Bol") — the whole card is one anchor. Hover and pressed both turn the label and border #3e3ac2 (--color-BlueBaseDarker). Focus draws the browser''s default blue ring, not the purple ring used on nav/CTA controls.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Axiforma
---

# Gousto

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Gousto; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/gousto/DESIGN.md
