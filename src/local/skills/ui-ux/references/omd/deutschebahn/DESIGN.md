---
name: Deutsche Bahn
colors:
  primary: '#ec0016'
  primary-hover: '#c50014'
  foreground: '#282d37'
  ink-strong: '#16181b'
  field: '#f0f3f5'
  border: '#d7dce1'
  focus: '#257fa8'
  accent: '#d96000'
  canvas: '#ffffff'
typography:
  button:
    fontSize: 16px
    fontWeight: 700
    use: the search button
rounded:
  sm: 4px
  pill: 12px
components:
  button-search:
    type: button
    backgroundColor: '#ec0016'
    textColor: '#ffffff'
    rounded: 4px
    height: 56px
    padding: 16px 32px
    typography: 16px / 700
    hover: '#c50014'
    pressed: '#c50014'
    focus: 'outline 2px solid #257fa8'
    use: 'Suchen in the journey planner — DB red, darkening to #c50014 on hover and press; focus is a 2px teal-blue outline.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#282d37'
    rounded: 0px
    height: 40px
    hover: '::after bar #282d37'
    pressed: '::after bar #282d37'
    focus: 'outline 2px solid #257fa8'
    use: Tickets & Angebote in the header — hover and press draw an ::after bar in the ink colour under the label; focus is the same 2px outline.
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#16181b'
    rounded: 4px
    height: 40px
    hover: rgba(90,94,104,0.24)
    pressed: rgba(90,94,104,0.32)
    focus: 'outline 2px solid #257fa8'
    use: Jetzt bestellen — a ghost button whose grey wash deepens from 24% on hover to 32% on press.
  input-station:
    type: input
    backgroundColor: '#f0f3f5'
    textColor: '#282d37'
    border: '#d7dce1'
    rounded: 0px
    height: 56px
    hover: '#f0f3f5'
    focus: 'outline 2px solid #257fa8'
    use: The departure and destination fields — grey fill with a bottom rule; hover changes nothing, focus draws the 2px outline.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: DB Screen Sans
    display: DB Screen Head
---

# Deutsche Bahn

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Deutsche Bahn; reproduced for educational reference. Full prose: https://oh-my-design.kr/deutschebahn/design.md
