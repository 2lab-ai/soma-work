---
name: Liner
colors:
  primary: '#2c783c'
  primary-hover: '#256a33'
  on-primary: '#ffffff'
  brand-line: '#349749'
  tab-selected: '#edf3ed'
  scholar: '#747a4d'
  write: '#536c7a'
  ink: '#1e1e1f'
  muted: '#818184'
  surface: '#ffffff'
  outline: '#e8e8e9'
  discount: '#f58800'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 500
    lineHeight: 1.1
    letterSpacing: '-2.16px'
    use: About-page hero line (Explore without doubt), Pretendard Variable
  display:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: '-1.04px'
    use: Home hero heading (필요할 때 믿고 쓰는 정확한 AI), Pretendard Variable
  section:
    fontSize: 42px
    fontWeight: 600
    lineHeight: 1.3
    use: Home section heading (어떤 일을 끝내고 싶으세요?) and the about-page statements, Pretendard Variable
  page-title:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.3
    use: Pricing page title (라이너 플랜) and its section headings, Pretendard Variable
  title:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.3
    use: Feature block headings on home (출처가 분명한 답변을 쉽게 이해해 보세요), Pretendard Variable
  card-title:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    use: Benefit headings on pricing and value headings on the about page, Pretendard Variable
  subtitle:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.3
    use: Home hero subtitle (the h1, 목적에 맞는 AI로 결과의 완성도를 높이세요), Pretendard JP Variable
  tab-label:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.3
    use: Labels of the 검색 / 연구 / 글쓰기 selector, Pretendard Variable
  feature-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.3
    use: Feature and testimonial headings on home, Pretendard Variable
  lead:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.3
    use: Product-section lead lines on home (넘쳐나는 정보와 불확실한 답변에 지치셨나요?), Pretendard Variable
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Long paragraphs on the about page and the hero card labels, Pretendard Variable
  button:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.3
    use: Labels of the 40px buttons, Pretendard Variable
  button-xl:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.3
    use: Labels of the 48px about-page buttons, Pretendard Variable
  nav:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.3
    use: Header menu labels (제품, API/MCP, 요금제, 더 알아보기, 회사 소개), Pretendard Variable
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.3
    use: Price captions and the small plan-table buttons on pricing, Pretendard Variable
  fine:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.3
    use: The 20% 할인 note on the annual billing option, Pretendard Variable
rounded:
  nav: 8px
  button: 10px
  button-xl: 12px
  menu-item: 6px
  pill: 200px
  tab: 9999px
spacing:
  tab-x: 20
  card-y: 40
  card-x: 24
  card-gap: 48
  menu: 8
components:
  primary-button:
    type: button
    backgroundColor: '#2c783c'
    textColor: '#ffffff'
    rounded: 10px
    height: 40px
    typography: 15px / 500 / 19.5px Pretendard Variable
    hover: 'bg #256a33 — the same settled value on all nine captured instances of this green fill across home, pricing and about; the pressed frame reads the same #256a33, so no separate pressed treatment is declared'
    states: rest and hover; focus was not measured
    use: 시작하기 in the header on home and pricing (84 x 40), Pro 선택하기 and Max 선택하기 on the plan cards (260 x 40) and 팀 플랜 시작하기 (156 x 40) at home::[data-omd-capture="6"]; the label sits on a 0px-padded button
    padding: 0px
    pressed: 'bg #256a33 (:hover + :active)'
    focus: 'shadow #00a0f0 0px 0px 0px 1px inset on :focus-visible'
  primary-button-xl:
    type: button
    backgroundColor: '#2c783c'
    textColor: '#ffffff'
    rounded: 12px
    height: 48px
    typography: 16px / 500 / 20.8px Pretendard Variable
    hover: 'bg #256a33'
    use: 'Start Your Search on the about page (240 x 48) at surface-3::[data-omd-capture="7"]; Try for free beside it is the white variant (#ffffff, text #1e1e1f, hover #fafafb)'
  outline-brand-button:
    type: button
    backgroundColor: transparent
    textColor: '#349749'
    border: '1px solid #349749'
    rounded: 10px
    height: 40px
    typography: 15px / 500 / 19.5px Pretendard Variable
    hover: bg rgba(44, 120, 60, 0.12) on both captured instances
    use: 문의하기 on the contact plan card (260 x 40) and 영업팀 문의하기 (128 x 40) on pricing at surface-2::[data-omd-capture="12"]
  outline-neutral-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1e1e1f'
    border: 1px solid rgba(148, 148, 151, 0.24)
    rounded: 10px
    height: 40px
    typography: 15px / 500 / 19.5px Pretendard Variable
    hover: 'bg #fafafb on all three captured instances'
    use: 바로 사용하기 on the Free plan card (260 x 40) and 자세히 보기 beside 팀 플랜 시작하기 at surface-2::[data-omd-capture="9"]
  product-cta-pill:
    type: button
    backgroundColor: '#2c783c'
    textColor: '#ffffff'
    rounded: 200px
    height: 48px
    typography: 16px / 400 / 20.8px Pretendard Variable (label)
    hover: 'bg #256a33; the Scholar pill #747a4d turns #686e45 and the Write pill #536c7a turns #4b616e'
    use: '바로 검색하기 in the 검색 section of home (141 x 48); the 연구 section repeats it in #747a4d (바로 시작하기) and the 글쓰기 section in #536c7a (바로 써보기) at home::[data-omd-capture="16"]; the white label sits on a child p'
  product-outline-pill:
    type: button
    backgroundColor: transparent
    textColor: '#349749'
    border: '1px solid #349749'
    rounded: 200px
    height: 48px
    typography: 16px / 400 / 20.8px Pretendard Variable (label)
    hover: bg rgba(148, 148, 151, 0.08), the same on the green, Scholar and Write siblings
    use: '자세히 보기 beside each product CTA (107 x 48) at home::[data-omd-capture="17"]; the Scholar and Write siblings take #747a4d and #536c7a borders and labels, and the three hero cards carry the same green-outlined 시작하기 pill (111 x 48)'
  product-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#1e1e1f'
    rounded: 9999px
    padding: 0px 20px
    height: 48px
    typography: 20px / 500 / 26px Pretendard Variable (label)
    selected: 'bg #edf3ed on the selected option (capture 10 against 11 and 12)'
    states: selected read from rest values; no pointer frame
    use: 검색 / 연구 / 글쓰기 selector on home at home::[data-omd-capture="11"]; captures 13-15 repeat the same selector
  billing-toggle:
    type: tab
    backgroundColor: transparent
    textColor: '#1e1e1f'
    rounded: 200px
    height: 44px
    typography: 15px / 500 / 19.5px Pretendard Variable
    selected: 'bg #ffffff with shadow rgba(0, 0, 0, 0.05) 0px 4px 12px 0px (capture 8, 연간 20% 할인)'
    states: selected read from rest values; the unselected option has one pointer frame, so no hover is declared
    use: 월간 / 연간 20% 할인 switch on pricing at surface-2::[data-omd-capture="7"]
  header-nav-item:
    type: button
    backgroundColor: transparent
    textColor: '#1e1e1f'
    rounded: 8px
    padding: 0px 4px
    height: 36px
    typography: 14px / 400 / 18.2px Pretendard Variable (label)
    hover: bg rgba(12, 137, 59, 0.08), the same on all five items on each of the three pages
    use: '제품, API/MCP, 요금제, 더 알아보기 and 회사 소개 in the header at home::[data-omd-capture="1"]; over the dark about-page hero the labels turn #ffffff and 시작하기 becomes a white button'
  language-select:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1e1e1f'
    border: 1px solid rgba(148, 148, 151, 0.24)
    rounded: 8px
    height: 32px
    typography: 13px / 400 / 16.9px Pretendard Variable
    states: 'expanded: the collector opened it and read the menu below'
    use: Select language, KO in the footer at home::[data-omd-capture="75"], 86 x 32
  select-menu:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #e8e8e9'
    rounded: 10px
    padding: 8px
    shadow: rgba(0, 0, 0, 0.05) 0px 4px 12px 0px
    selected: item bg rgba(148, 148, 151, 0.08), radius 6px (menu-0-3)
    use: Language menu opened from the footer select, 320 x 150, at home::[data-omd-interaction-capture="menu-0-0"]; the same menu opens on all three pages
  faq-accordion:
    type: button
    backgroundColor: transparent
    textColor: '#1e1e1f'
    rounded: 10px
    padding: 0px 8px 0px 4px
    height: 56px
    typography: 16px / 500 / 20.8px Pretendard Variable
    states: rest only; no row was opened and no pointer frame was recorded
    use: Questions under 자주 묻는 질문 on home and pricing (944 x 56) at home::[data-omd-capture="28"]
  hero-card:
    type: card
    backgroundColor: transparent
    border: 1px solid rgba(20, 55, 27, 0.3) on the right edge only
    padding: 40px 24px
    size: 389px x 244px
    use: 'The three hero cards on home (정확한 정보를 찾을 때, 학술 연구를 준비할 때, 논리적인 글이 필요할 때) at home::div, 48px between label and pill; labels 16px uppercase in #818184'
fonts:
  roles:
    body: Pretendard Variable
    ui: Pretendard JP Variable
---

# Liner

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Liner; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/liner/DESIGN.md
