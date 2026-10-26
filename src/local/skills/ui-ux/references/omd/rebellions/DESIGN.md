---
name: Rebellions
colors:
  primary: '#52f756'
  on-primary: '#24292e'
  ink: '#24292e'
  canvas: '#f6f8fa'
  on-dark: '#d9e4ed'
  white: '#ffffff'
  black: '#000000'
typography:
  display-hero:
    fontSize: 64.7px
    fontWeight: 400
    lineHeight: 1.25
    use: Page H1 and hero headline at 1440px (About 'AI that Scales, without the Energy Burn.'); fluid, measured at a 1440 viewport
  hero-lead:
    fontSize: 27.8px
    fontWeight: 600
    lineHeight: 1.25
    use: Hero sub-line under the headline
  section:
    fontSize: 52.9px
    fontWeight: 500
    lineHeight: 1.25
    use: Home section headlines (대규모 AI 서비스 추론 성능)
  block-title:
    fontSize: 39.7px
    fontWeight: 400
    lineHeight: 1.25
    use: Block titles (Our Story, Latest Updates)
  milestone:
    fontSize: 31.8px
    fontWeight: 600
    lineHeight: 1.25
    use: About timeline milestone titles
  lead:
    fontSize: 21.2px
    fontWeight: 400
    lineHeight: 1.5
    use: Section intro paragraphs
  card-title:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.25
    use: Latest Updates card titles
  button:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    use: Primary and secondary button labels
  nav:
    fontSize: 20px
    fontWeight: 500
    use: Header navigation items (80px tall row)
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    use: Document default
  footer-link:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.4
    use: Footer sub-links
  caption:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Footer contact pill label
rounded:
  none: 0px
spacing:
  cta-y: 10
  cta-x: 24
  secondary-x: 40
  pill-y: 8
  pill-x: 20
components:
  cta-primary:
    type: button
    backgroundColor: '#52f756'
    textColor: '#24292e'
    rounded: 0px
    height: 50px
    padding: 10px 24px
    typography: 20px / 600 Pretendard
    hover: 'bg #000000, label #f6f8fa, arrow icon swaps (0.3s ease)'
    pressed: same as hover
    use: Primary call to action (자세히 보기, Model Zoo, 도입 사례 알아보기) on home and product pages
  button-secondary:
    type: button
    backgroundColor: '#d9e4ed'
    textColor: '#24292e'
    rounded: 0px
    height: 60px
    padding: 0 40px
    typography: 20px / 600 Pretendard
    hover: 'bg #52f756 (0.3s ease)'
    pressed: same as hover
    use: Full-width office links on the About page (Get directions)
  contact-pill:
    type: button
    backgroundColor: '#000000'
    textColor: '#52f756'
    rounded: 0px
    height: 36px
    padding: 8px 20px
    typography: 14px / 500 Pretendard
    hover: 'bg #52f756, label #24292e (instant)'
    pressed: same as hover
    use: Footer contact call to action (도입 문의하기) on every page
  nav-contact:
    type: tab
    textColor: '#52f756'
    height: 80px
    typography: 20px / 700 Pretendard
    states: 'hover and pressed: no change (probe); focus not measured'
    use: 'The one green item in the header navigation (도입 문의하기); other items are 20px / 500 in #d9e4ed over the home hero and #24292e on light pages'
  carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#24292e'
    border: '1px solid #24292e'
    rounded: 0px
    width: 40px
    disabled: observed disabled at the first slide; visual change not measured
    use: Square previous/next arrows of the partner and updates carousels
  update-card:
    type: card
    rounded: 0px
    width: 448px
    typography: 24px / 400 Pretendard title
    use: 'Latest Updates news card: square 408px image over a 24px title, no fill, border or shadow'
fonts:
  roles:
    display: Pretendard
    body: Pretendard
---

# Rebellions

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Rebellions; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/rebellions/DESIGN.md
