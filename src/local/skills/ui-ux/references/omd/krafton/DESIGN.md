---
name: KRAFTON
colors:
  primary: '#000000'
  brand: '#000000'
  canvas: '#000000'
  foreground: '#ffffff'
  muted: '#777777'
  on-primary: '#ffffff'
  surface: '#0a0a0a'
  hairline: '#393939'
  body: '#555555'
  content: '#222222'
  placeholder: '#adadad'
  disabled: '#dddddd'
  error: '#ed2929'
  link: '#3d7fd9'
typography:
  hero-logotype:
    fontSize: 140px
    fontWeight: 400
    use: Hero logotype, KRAFTON custom font, display only
  page-header:
    fontSize: 70px
    fontWeight: 700
    use: PageHeader title on light pages
  article-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.9
    use: Article/single body copy
  nav:
    fontSize: 18px
    fontWeight: 600
    use: Navigation, Poppins
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
    use: Base body text
  selector:
    fontSize: 13px
    fontWeight: 400
    use: Language selector links
  footer:
    fontSize: 12px
    fontWeight: 400
    use: Footer copyright, Poppins
rounded:
  sm: 0px
  md: 0px
  lg: 0px
  full: 9999px
spacing:
  xs: 15
  sm: 20
  md: 40
  base: 60
  lg: 80
  xl: 100
  xxl: 140
components:
  button-primary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '2px solid #000000'
    padding: 8px 43px 8px 15px
    typography: 14px / 700
    rounded: 0px
    hover: 'bg #000000 fg #ffffff (inverted)'
    use: Download button on white surface
  input-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '2px solid #000000'
    height: 46px
    padding: 12px 20px
    typography: 15px / 500
    rounded: 0px
    use: 'Search input, placeholder #adadad'
  tab-third:
    type: tab
    backgroundColor: '#f7f7f7'
    textColor: '#000000'
    typography: 19px / 500
    height: 2.4em
    active: 'bg #000000 fg #ffffff 19px/700'
    use: ThirdDepthTab navigation
  listItem-link:
    type: listItem
    textColor: '#222222'
    typography: 15px / 500
    hover: underline expands 0 to 100% 2px over 0.3s
    use: Download link, text + animated underline
fonts:
  roles:
    sans: Poppins
    mono: SF Mono
---

# KRAFTON

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KRAFTON; reproduced for educational reference. Full prose: https://oh-my-design.kr/krafton/design.md
