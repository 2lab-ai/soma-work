---
name: Too Good To Go
colors:
  leafy-green: '#00615f'
  leafy-green-alt: '#005250'
  creamy-oat-milk: '#f9f3f0'
  oat-milk-alt: '#f3ebe8'
  crunchy-apple: '#79e4a7'
  dark-crunchy-apple: '#03a97b'
  dark-green: '#013d3c'
  juicy-watermelon: '#ff7973'
  sour-lemon: '#fff29a'
  highlight: '#fffb9b'
  mint-hover: '#67d695'
  tertiary-text: '#339a72'
  header-dark: '#252d2d'
  text-on-dark: '#dee3e3'
  foreground: '#5f6d6d'
  button-ink: '#012625'
  canvas: '#ffffff'
  button-hover: '#ececee'
  button-pressed: '#dfdfe2'
typography:
  display:
    fontSize: 72px
    fontWeight: 900
    use: hero heading, uppercase
  body:
    fontSize: 16px
    fontWeight: 500
    use: buttons; body in Tenon
rounded:
  pill: 120px
components:
  button-white:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#012625'
    rounded: 120px
    height: 51px
    padding: 16px 24px
    typography: 16px / 500
    hover: '#ececee'
    pressed: '#dfdfe2'
    focus: 'outline 2px solid #ffffff'
    use: Download the app / Sign up your business on the green hero — a white pill with dark-green ink; greys a step on hover and press, a 2px white outline on focus.
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    height: 21px
    typography: 14px / 400
    hover: transparent
    pressed: transparent
    use: About / Business in the header over the hero — white text; hover and press change nothing; focus is the browser's ring.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Korolev
    sans: Tenon
---

# Too Good To Go

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Too Good To Go; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/toogoodtogo/DESIGN.md
