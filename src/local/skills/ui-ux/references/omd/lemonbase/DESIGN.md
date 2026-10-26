---
name: Lemonbase
colors:
  primary: '#ffffff'
  canvas: '#111111'
  on-dark: '#fafafa'
  action-ink: '#1a2128'
  muted: '#677583'
  faint: '#cfd3d8'
  footer-link: '#858585'
typography:
  hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-1.68px'
    use: Page headline (h1) on home and pricing, Onest
  section:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.21
    use: Home feature heading (h2), Pretendard Bold
  subsection:
    fontSize: 35px
    fontWeight: 700
    lineHeight: 1.4
    use: Heading (h3) on pricing, home and the inquiry page, Pretendard Bold
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    use: Running text (p) on all three pages, Pretendard Regular
  action-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.56
    use: Hero action label, Pretendard Bold
rounded:
  nav: 6px
  action: 8px
  action-lg: 12px
  pill: 100px
  circle: 999px
spacing:
  action-y: 16
  action-x: 16
  action-lg-y: 16
  action-lg-x: 20
  pill-y: 8
  pill-x: 12
  nav: 8
components:
  hero-primary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2128'
    rounded: 12px
    padding: 16px 20px
    size: 142px x 60px
    typography: 18px / 700 / 28.08px Pretendard Bold
    states: 'rest on home captures 6 and 16 and pricing capture 16; the hover frame recorded no change; the pressed frame''s #ff0000 text and border are Chrome''s default active-link colour on the a container (the label is a child p that keeps #1a2128) and its 0.996-alpha fill is a transition frame, so no hover or pressed value is declared'
    use: 'White hero and closing-band action (a) at home::[data-omd-capture="6"], 142 x 60; the label is a child p, #1a2128 18px / 700 / 28.08px Pretendard Bold'
  hero-ghost-action:
    type: button
    backgroundColor: transparent
    textColor: '#fafafa'
    rounded: 12px
    padding: 16px
    size: 145px x 60px
    typography: 18px / 700 / 28.08px Pretendard Bold
    states: rest on home captures 7 and 17 and pricing capture 17; hover recorded no change and the pressed frame shows only the container's default active-link colour, so no state value is declared
    use: 'Transparent companion to the white hero action at home::[data-omd-capture="7"], 145 x 60, label a child p in #fafafa; the computed border is 0px and the served HTML draws a 1px border through Framer border variables outside the captured properties, so no border is claimed'
  header-primary-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2128'
    rounded: 8px
    padding: 16px
    size: 114px x 40px
    typography: 14px / 400 / 21.98px Pretendard Bold
    states: rest on home capture 5 and pricing captures 5 and 6; the home hover frame holds a 0.98-alpha fill (a transition frame) while pricing capture 5 records no hover change, so no hover is declared; pressed shows only the container's default active-link colour
    use: 'Global navigation white action (a) at home::[data-omd-capture="5"], 114 x 40 (111 x 40 on pricing capture 6); the label is a child p in #1a2128, Pretendard Bold at a computed weight of 400'
  section-ghost-link:
    type: button
    backgroundColor: transparent
    textColor: '#fafafa'
    rounded: 8px
    padding: 16px
    size: 96px x 40px
    typography: 14px / 400 / 21.98px Pretendard Bold
    states: rest on home captures 8-10 and pricing captures 7-10 (123 x 40 and 118 x 40 there); hover recorded no change, and the pressed frame is the container's default active-link colour with a near-transparent alpha tween, so no state is declared
    use: 'Transparent section link at home::[data-omd-capture="8"], 96 x 40; the label is a child p in #fafafa'
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#f1f5f9'
    rounded: 6px
    padding: 8px
    size: 40px x 38px
    typography: 14px / 400 / 21.98px Pretendard Regular
    hover: 'bg #1c1c1c'
    states: 'hover fill #1c1c1c recorded on home and on pricing (capture 2 on both, a cross-surface match), and the pressed frame carries the same opaque fill, so the transition had finished before mousedown; the pressed frame''s #ff0000 text is the container''s default active-link colour, not a label change'
    use: 'Short global navigation link (a) at home::[data-omd-capture="2"], 40 x 38; the label is a child p in #f1f5f9'
  pill-segment:
    type: button
    backgroundColor: transparent
    textColor: '#677583'
    rounded: 100px
    padding: 8px 12px
    size: 88px x 38px
    typography: 14px / 400 / 21.98px Pretendard Bold
    states: 'three sibling buttons on home and pricing (captures 11-13): capture 11 records a #ffffff fill with a #121412 label while 12 and 13 are transparent with #677583 labels; no aria-selected or aria-pressed was recorded, so the white one is described as a variant, not a selected state; hover and pressed frames recorded no change'
    use: Pill segment button at home::[data-omd-capture="12"], 88 x 38 (the white variant is 85 x 38); labels are child p nodes
  carousel-arrow:
    type: button
    backgroundColor: rgba(20, 20, 20, 0.9)
    textColor: '#ffffff'
    border: '1px #2e2e2e'
    rounded: 999px
    size: 40px x 40px
    states: rest on capture 15 (home, pricing) and capture 1 (inquiry); capture 14 (and inquiry capture 0) carries the disabled attribute with the same fill, border and colour, and opacity is not among the captured properties; hover and pressed recorded no change
    use: Circular previous/next control (button, icon only) at home::[data-omd-capture="15"], 40 x 40
  footer-link:
    type: listItem
    textColor: '#858585'
    typography: 14px / 400 / 21.98px Pretendard Regular
    height: 16px
    hover: 'fg #fafafa'
    states: 'hover #fafafa on all six probed links (captures 18-23) on home and on pricing, with the identical opaque value in the pressed frame, so the transition had settled; links 24-46 lie beyond the collector''s first 24 probed controls and carry no frame'
    use: Footer text link (a.framer-text) at home::[data-omd-capture="18"]; 29 links on home and on pricing
  inquiry-text-field:
    type: input
    backgroundColor: transparent
    textColor: '#fafafa'
    rounded: 0px
    padding: 0px
    size: 452px x 24px
    typography: 14px / 400 / 16.8px Pretendard Regular
    states: 'rest on four fields (text, text, email, tel: captures 2, 4, 6, 7); the pressed frame shifts padding to 24px 0px 8px because mousedown focuses the field, so it is a focus effect and is not declared; after reportValidity() only the first field shows that shift (it receives focus) and the others record no change, so no error styling is declared'
    use: 'Inquiry form text field at surface-3::[data-omd-capture="2"] on the #111111 page'
  inquiry-select:
    type: input
    backgroundColor: transparent
    textColor: '#8a8f98'
    rounded: 0px
    padding: 14px
    size: 466px x 52px
    typography: 14px / 400 / 16.8px Pretendard Regular
    states: rest on three selects (captures 3, 5, 8); the pressed frame's 24px 14px 8px padding follows focus and is not declared, and the reportValidity() pass recorded no change
    use: Inquiry form select at surface-3::[data-omd-capture="3"]
  inquiry-submit:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1a2128'
    rounded: 8px
    padding: 0px
    size: 480px x 48px
    typography: 14px / 400 / 21.98px Pretendard Bold
    states: rest; hover and pressed recorded no change; the button was never clicked
    use: 'Full-width inquiry submit button at surface-3::[data-omd-capture="11"]; the label (제품 도입 문의하기) is a child p in #1a2128'
fonts:
  roles:
    display: Onest
    body: Pretendard Regular
    heading: Pretendard Bold
---

# Lemonbase

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Lemonbase; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/lemonbase/DESIGN.md
