---
name: PeopleFund
colors:
  primary: '#ffc32d'
  canvas: '#ffffff'
  surface: '#f6f6f6'
  surface-alt: '#f5f5f5'
  ink: '#000000'
  ink-secondary: '#2e2e2e'
  charcoal: '#2e303b'
  muted: '#6a6a6a'
  muted-light: '#90a4af'
  hairline: '#d0d8dc'
  on-primary: '#000000'
  footer-bg: '#263238'
  error: '#ff4d4f'
  success: '#37c94d'
  accent-blue: '#2054ae'
typography:
  section:
    fontSize: 29px
    fontWeight: 600
    lineHeight: 1.31
    letterSpacing: '-0.4px'
    use: Section headings H2, Pretendard SemiBold
  subsection:
    fontSize: 23px
    fontWeight: 600
    lineHeight: 1.39
    letterSpacing: '-0.3px'
    use: Sub-section headings H3
  card-head:
    fontSize: 19px
    fontWeight: 600
    lineHeight: 1.37
    letterSpacing: '-0.3px'
    use: Card headings H4
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body copy
  nav:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1
    use: Nav link labels
  button:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1
    use: Primary CTA button label
  button-nav:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Nav action buttons (signup/login)
rounded:
  none: 0px
  sm: 10px
  md: 16px
  pill: 30px
  full: 9999px
spacing:
  xs: 3
  sm: 6
  md: 12
  base: 20
  lg: 32
  xl: 48
  section: 64
components:
  button-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    height: 46px
    padding: 0px
    typography: 15px / 600 Pretendard
    use: Primary 'View Products' CTA on hero sections
  button-nav-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2e303b'
    border: '1px solid #d0d8dc'
    rounded: 10px
    height: 50px
    padding: 0px 20px
    typography: 16px / 400 Pretendard
    use: Nav action buttons — 투자회원가입, 로그인
  button-dark-pill:
    type: button
    backgroundColor: rgba(0,0,0,0.2)
    textColor: '#000000'
    border: 1px solid rgba(255,255,255,0.2)
    rounded: 30px
    height: 58px
    padding: 17px 32px
    typography: 16px / 400 Pretendard
    use: Phone/FAQ contact pill buttons on dark hero section
  badge-status:
    type: badge
    backgroundColor: '#ffc32d'
    textColor: '#000000'
    rounded: 0px
    padding: 3px 6px
    typography: 12px / 600 Pretendard
    use: Investment status labels — NOTICE, HOT, NEW, 마감임박
  badge-progress:
    type: badge
    backgroundColor: '#2054ae'
    textColor: '#ffffff'
    rounded: 4px
    typography: 12px / 400 Pretendard
    use: Progress / percent-funded status on invest cards
  card-product:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    use: Investment product cards on product listing page
  card-feature:
    type: card
    backgroundColor: '#f6f6f6'
    textColor: '#000000'
    rounded: 8px
    use: Feature highlight cards on homepage sections
  nav-link:
    type: tab
    textColor: '#2e303b'
    typography: 16px / 500 Pretendard
    use: Top nav items — 투자, 대출, 이용안내
    active: 'text #000000 bold on active'
  input-default:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #d0d8dc'
    rounded: 10px
    typography: 16px / 400 Pretendard
    use: Standard form input fields
fonts:
  roles:
    sans: Pretendard
    fallback: Lato, "Noto Sans KR", sans-serif
---

# PeopleFund

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to PeopleFund; reproduced for educational reference. Full prose: https://oh-my-design.kr/peoplefund/design.md
