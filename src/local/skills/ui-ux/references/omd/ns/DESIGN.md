---
name: NS
colors:
  brand-yellow: '#ffc917'
  brand-yellow-shade: '#ffb519'
  brand-yellow-strong: '#8a6000'
  brand-yellow-pale: '#fcf6e8'
  brand-blue: '#003082'
  brand-blue-subdued: '#193370'
  action-blue: '#0063d3'
  action-blue-shade: '#004ba0'
  action-blue-subdued: '#1f55b2'
  foreground: '#003082'
  text-strong: '#252528'
  text-subdued: '#404144'
  text-subtle: '#75767c'
  canvas: '#ffffff'
  background-base: '#f7f7f9'
  border: '#e4e5e8'
  border-strong: '#93949a'
  success: '#008672'
  critical: '#e2103d'
  attention: '#d44504'
  highlight: '#7b55cd'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: buttons, links and forms
  nav:
    fontSize: 18px
    fontWeight: 700
    use: main navigation
rounded:
  sm: 4px
components:
  button-primary:
    type: button
    backgroundColor: '#0063d3'
    textColor: '#ffffff'
    rounded: 4px
    height: 45px
    padding: 10px 18px
    typography: 16px / 400
    shadow: 'inset 0 -2px 0 #004ba0'
    hover: 'inset 0 -50px 0 #004ba0'
    pressed: 'inset 0 -50px 0 #004ba0'
    focus: 'outline 1px dotted #0063d3'
    use: Plannen in the journey planner — blue with a 2px darker bottom edge that floods the whole button on hover (inset shadow -2px → -50px).
  button-yellow:
    type: button
    backgroundColor: '#ffc917'
    textColor: '#003082'
    rounded: 4px
    height: 45px
    padding: 10px 18px
    typography: 16px / 400
    shadow: 'inset 0 -2px 0 #ffb519'
    hover: 'inset 0 -50px 0 #ffb519'
    pressed: 'inset 0 -50px 0 #ffb519'
    focus: 'outline 1px dotted #003082'
    use: 'Koop nu — NS yellow with blue text; the same flood from a #ffb519 bottom edge on hover.'
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#003082'
    border: '#003082'
    rounded: 4px
    height: 45px
    padding: 10px 18px
    typography: 16px / 400
    hover: transparent
    pressed: transparent
    focus: 'outline 1px dotted #0063d3'
    use: 'Bestel treinkaartje — a faint 16%-alpha border at rest that turns solid #003082 on hover and press.'
  link-header:
    type: button
    backgroundColor: transparent
    textColor: '#003082'
    rounded: 0px
    height: 25px
    typography: 14px / 400
    hover: transparent
    pressed: transparent
    use: 'Zakelijk / In English — blue text that gains a yellow #ffc917 ::after bar on hover; focus adds a #0063d3 ring on ::before.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: NS Sans
---

# NS

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NS; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/ns/DESIGN.md
