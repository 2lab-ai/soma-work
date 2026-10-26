---
name: TMAP Mobility
colors:
  primary: '#0064ff'
  ink: '#000000'
  canvas: '#ffffff'
  menu-link: '#585858'
  chip-label: '#464646'
  footer: '#777777'
  surface-blue: '#f1f8ff'
  hairline: '#e5e5e5'
  search-border: '#f2f0f0'
  badge-border: '#dbdbdb'
  on-image: '#ffffff'
typography:
  display:
    fontSize: 61.44px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: Company value headline (h3) on the about page
  hero:
    fontSize: 44.16px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: Home hero headline (h2), white over photography
  page-title:
    fontSize: 44.16px
    fontWeight: 700
    lineHeight: 1.39
    letterSpacing: '-0.32px'
    use: Service page title (h1) on the navigation page
  section:
    fontSize: 34.56px
    fontWeight: 700
    lineHeight: 1.43
    letterSpacing: '-0.32px'
    use: Feature section heading (h4) on the navigation page
  card-title:
    fontSize: 28.8px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: Article card heading (h4) on home
  eyebrow:
    fontSize: 23.04px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: Blue section eyebrow (h2) on the about page; the first one is set at 600
  nav:
    fontSize: 15.36px
    fontWeight: 700
    lineHeight: 1.4
    use: Top navigation item
  menu-title:
    fontSize: 15.36px
    fontWeight: 700
    lineHeight: 1.2
    use: Mega-menu section title
  menu-link:
    fontSize: 13.44px
    fontWeight: 800
    lineHeight: 1.2
    use: Mega-menu service link
  chip:
    fontSize: 13.44px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: '-0.32px'
    use: Home quick-link chip and image badge label
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: '-0.32px'
    use: Body text
  footer-nav:
    fontSize: 15.36px
    fontWeight: 700
    lineHeight: 1.2
    use: Footer navigation (letter-spacing computes as -2%)
rounded:
  sm: 4px
  md: 9.6px
  lg: 19.2px
  search: 34.56px
  pill: 43.2px
  full: 100px
spacing:
  nav-x: 20.16
  menu-y: 7.68
  menu-x: 23.04
  search-y: 23.04
  search-x: 28.8
  chip: 11.52
  badge: 10.56
  pill-y: 8.64
  pill-x: 21.12
  panel: 67.2
  news-row: 33.6
components:
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    padding: 0px 20.16px
    height: 22px
    typography: 15.36px / 700 / 21.5px Pretendard
    selected: 'fg #0064ff on the item of the current section'
    states: selected variant read from rest values (surface-2 capture 5, 티맵 서비스, and surface-3 capture 4, 티맵 피플, against their black siblings); no pointer frame; focus is not declared from the capture
    use: Top navigation item (티맵 피플, 티맵 서비스, 티맵 이야기, 지속가능경영, 고객지원) at home::[data-omd-capture="4"], in a 93px header
  mega-menu-title:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 4px
    padding: 7.68px 23.04px
    height: 34px
    typography: 15.36px / 700 / 18.4px Pretendard
    hover: bg rgba(0, 100, 255, 0.1)
    pressed: bg rgba(0, 100, 255, 0.1)
    states: rest, hover and pressed; two elements on two pages (surface-2 capture 12, surface-3 capture 10) read the same 10% blue tint in both frames; focus is not declared from the capture
    use: Section title in the header mega menu (e.g. 회사소개, 장소, 운전) at home::[data-omd-capture="9"]
  mega-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#585858'
    rounded: 4px
    padding: 7.68px 23.04px
    height: 31px
    typography: 13.44px / 800 / 16.1px Pretendard
    states: rest only; no state frame
    use: Service link under a mega-menu title (e.g. 내비게이션, 주차, 대중교통) at home::[data-omd-capture="13"]; 23 per page
  search-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #f2f0f0'
    rounded: 34.56px
    padding: 23.04px 28.8px
    height: 69px
    typography: 16px / 400 / 22.4px Pretendard
    shadow: rgba(0, 0, 0, 0.08) 0px 3px 5px 0px
    states: rest only; no state frame
    use: Home search launcher (어디로 갈까요?) at home::[data-omd-capture="56"], 467 x 69
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  category-chip:
    type: button
    backgroundColor: transparent
    textColor: '#464646'
    border: '2px solid #e5e5e5'
    rounded: 9.6px
    padding: 11.52px
    height: 43px
    typography: 13.44px / 800 / 16.1px Pretendard
    states: rest only on six siblings (capture 57 to 62); no state frame
    use: Quick-link chips on home (회사소개, 조직문화, 내비게이션, 운전점수/보험혜택(UBI), 어디갈까, 대리운전) at home::[data-omd-capture="57"]
  outline-pill:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.1)
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 43.2px
    padding: 8.64px 21.12px
    height: 46px
    typography: 15.36px / 700 / 25px Pretendard
    states: rest only; no state frame
    use: Outline action over photography (티맵 서비스 on the home hero, 채용 공고 확인하기 on the about page); the 2px edge and 10% black fill sit on the container, the padding on its inner link (home::[data-omd-capture="52"]), the label on a 15.36px / 700 child
  outline-pill-dark:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '2px solid #000000'
    rounded: 100px
    padding: 8.64px 21.12px
    height: 46px
    typography: 15.36px / 700 / 25px Pretendard
    states: rest only; no state frame
    use: Black outline action on white beside the home news list at home::[data-omd-capture="72"], 169 x 46; its inner link keeps a 43.2px radius
  image-badge:
    type: badge
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '2px solid #ffffff'
    rounded: 9.6px
    padding: 10.56px
    height: 41px
    typography: 13.44px / 800 / 16.1px Pretendard
    use: 'Category badge over article photographs on home (seven captured); on a white card the same badge is black text with a 2px #dbdbdb edge, and on the navigation page it carries a 2px #777777 edge'
  service-panel:
    type: card
    backgroundColor: '#f1f8ff'
    rounded: 19.2px
    padding: 67.2px
    size: 1056px x 487px
    use: Feature panel on the navigation page (five li.ServiceInfoSection items); the inner article carries the 67.2px padding, a 34.56px / 700 title and 23.04px / 400 copy
  interview-banner:
    type: card
    textColor: '#ffffff'
    rounded: 19.2px
    size: 1056px x 697px
    use: Image-led interview banner on home and the about page with a 44.16px / 700 white heading; its background is imagery, so no fill is claimed
  news-row:
    type: listItem
    textColor: '#000000'
    border: '1px solid #000000 (bottom only)'
    padding: 33.6px 0px
    size: 691px wide
    use: Press row in the home news list; rows are divided by a 1px black bottom rule
  history-year:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    height: 25px
    typography: 15.36px / 700 / 25px Pretendard
    selected: 'fg #0064ff (2002 at rest, capture 69)'
    states: selected variant read from rest values (capture 69 against 21 siblings from capture 70); no pointer frame; the collector recorded a disabled attribute on part of the set, which is not declared as a state
    use: Year selector of the history timeline on the about page at surface-3::[data-omd-capture="70"]
fonts:
  roles:
    sans: Pretendard
---

# TMAP Mobility

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to TMAP Mobility; reproduced for educational reference. Full prose: https://oh-my-design.kr/tmap/design.md
