---
name: NHS website
colors:
  primary: '#005eb8'
  primary-dark: '#003087'
  primary-hover: '#004b93'
  primary-active: '#002f5c'
  primary-reverse-border: '#337ec6'
  primary-tint: '#d9e7f4'
  foreground: '#212b32'
  text-secondary: '#4c6272'
  grey-2: '#768692'
  grey-3: '#aeb7bd'
  border: '#d8dde0'
  background: '#f0f4f5'
  canvas: '#ffffff'
  button: '#007f3b'
  button-hover: '#00662f'
  button-active: '#00401e'
  link-visited: '#330072'
  link-hover: '#7c2855'
  pink: '#ae2573'
  error: '#d5281b'
  focus: '#ffeb3b'
  pale-yellow: '#fff9c4'
  warm-yellow: '#ffb81c'
  orange: '#ed8b00'
  aqua-green: '#00a499'
typography:
  nav:
    fontSize: 16px
    use: header navigation and the search field
  body:
    fontSize: 19px
    use: paragraphs, 19px / 28px, 400; the primary button at 600
  h2:
    fontSize: 22px
    use: h2 22px / 30.25px and action links, 600
  card:
    fontSize: 26px
    use: card headline links, 26px / 32px, 600
  h1:
    fontSize: 32px
    use: h1 32px / 36px, 600
rounded:
  sm: 4px
components:
  button-primary:
    type: button
    backgroundColor: '#007f3b'
    textColor: '#ffffff'
    rounded: 4px
    height: 60px
    padding: 14px 16px
    typography: 19px / 600
    shadow: '0 4px 0 #00401e'
    hover: '#00662f'
    pressed: '#00401e'
    focus: '#ffeb3b, fg #212b32, shadow 0 4px 0 #212b32'
    use: The green primary button (--nhsuk-button-colour). On the homepage it appears in NHS's own cookie banner. A hard 4px shadow beneath; hover and active darken along the token ramp; focus repaints it yellow with a black bottom edge.
  link-card:
    type: button
    backgroundColor: transparent
    textColor: '#005eb8'
    height: 32px
    typography: 26px / 600
    hover: 'fg #7c2855'
    pressed: '#ffeb3b, fg #212b32'
    focus: '#ffeb3b, fg #212b32, shadow 0 -2px 0 #ffeb3b, 0 4px 0 #212b32'
    use: Card headline links. Hover changes only the text colour, to --nhsuk-link-hover-colour; focus fills yellow and draws a 4px black bottom border as a box-shadow.
  link-action:
    type: button
    backgroundColor: transparent
    textColor: '#005eb8'
    height: 44px
    typography: 22px / 600
    hover: 'fg #7c2855'
    pressed: '#ffeb3b, fg #212b32'
    focus: '#ffeb3b, fg #212b32, shadow 0 -2px 0 #ffeb3b, 0 4px 0 #212b32'
    use: Action links (Order a repeat prescription), indented for their arrow icon. The same hover and focus as card links.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 56px
    padding: 16px 2px
    typography: 16px / 400
    hover: transparent
    pressed: '#ffeb3b, fg #212b32'
    focus: '#ffeb3b, fg #212b32, shadow inset 0 -4px 0 #212b32'
    use: Header navigation on the blue bar (Health A to Z). No hover change; focus fills yellow with a black edge drawn inset.
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    height: 40px
    padding: 0 12px
    typography: 16px / 400
    hover: '#ffffff'
    focus: 'ring 0 0 0 4px #ffeb3b, border #212b32'
    use: The header search field, rounded on its left (4px 0 0 4px) where it joins the search button. Focus draws a 4px yellow ring and turns the border near-black — the input variant of the focus style, with no fill.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Frutiger
---

# NHS website

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NHS website; reproduced for educational reference. Full prose: https://oh-my-design.kr/nhs/design.md
