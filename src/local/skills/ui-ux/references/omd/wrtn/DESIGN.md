---
name: Wrtn
colors:
  ink: '#262626'
  primary: '#f54211'
  muted: '#8a8a8a'
  faint: '#c5c5c5'
  canvas: '#ffffff'
  surface: '#f7f7f7'
  subtle: '#f1f1f1'
  hairline: '#d3d3d3'
  corp-ink: '#333333'
  corp-ink-strong: '#1a1a1a'
  corp-surface: '#f5f5f5'
  corp-muted: '#858e95'
  corp-on-dark: '#f6f6f6'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: wrtn.ai body text (line height computes normal)
  composer-tab:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Composer mode tab labels on wrtn.ai
  nav-label:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.4
    use: Navigation rail labels on wrtn.ai (홈, 도구, 혜택, 저장됨)
  page-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Page title on the tools page (도구)
  tool-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Tool name on tool cards
  tool-desc:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.4
    use: Tool description and category chip labels on the tools page
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.5
    use: Footnote on the tools page
  corp-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: wrtn.io body text
  corp-display:
    fontSize: 160px
    fontWeight: 700
    lineHeight: 0.88
    letterSpacing: '-4.8px'
    use: Oversized section word on wrtn.io (ConsumerServices), Manrope
  corp-section:
    fontSize: 38px
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: '-0.76px'
    use: wrtn.io section heading (주요 소식)
  corp-service:
    fontSize: 34px
    fontWeight: 700
    lineHeight: 1.4
    use: Service names on wrtn.io (뤼튼, 크랙, 캬라푸)
  corp-card-title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.2px'
    use: News card headline on wrtn.io
  corp-nav:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: '-0.16px'
    use: wrtn.io top navigation
rounded:
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  pill: 36px
  full: 999px
spacing:
  pill-x: 20
  track: 6
  popover: 12
  card-x: 24
  cta-x: 50
components:
  login-button:
    type: button
    backgroundColor: '#262626'
    border: '1px solid #262626'
    rounded: 36px
    padding: 0px 20px
    height: 36px
    states: rest only; no state frame
    use: 'Header 로그인 link on wrtn.ai at home::[data-omd-capture="7"], 78 x 36; the anchor computes #262626 text on its own #262626 fill, so the visible label sits in a child that was not captured and no label colour or font is claimed; styles were read without following the link'
    typography: 16px / 400
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  signup-button:
    type: button
    backgroundColor: transparent
    border: '1px solid #d3d3d3'
    rounded: 36px
    padding: 0px 20px
    height: 36px
    states: rest only; no state frame
    use: Header 무료로 회원가입 link on wrtn.ai at home::[data-omd-capture="6"], 130 x 36; label colour and font are not claimed for the same reason as the login pill; never followed
  composer-mode-tabs:
    type: tab
    backgroundColor: transparent
    textColor: '#8a8a8a'
    height: 34px
    typography: 16px / 500 / 24px Pretendard
    selected: 'label #262626 at 500 (capture 9)'
    states: selected variant read from rest values (capture 9 against 10-12); the collector selected three of the tabs in turn and each became aria-selected (interactions tab-2 to tab-4); the track's focus frame matched its rest values within the compared scope, so no focus value is declared
    use: 'Mode tabs (채팅, AI 탐지방어, 유튜브 요약, 실시간 녹음) above the home composer, inside a #f7f7f7 track with 300px radius and 6px padding (466 x 46) at home::[data-omd-capture="8"]; the tab buttons are transparent and the label colour sits on the inner text'
  recording-action:
    type: button
    backgroundColor: '#f54211'
    rounded: 60px
    size: 60px x 60px
    shadow: rgba(0, 0, 0, 0.1) 0px 0px 15px 0px
    states: rest only; it appeared when the collector selected the 실시간 녹음 tab (interaction tab-4); no pointer frame
    use: Round primary action in the 실시간 녹음 (live recording) panel of the home composer at home::[data-omd-interaction-capture="tab-4-4"]; its icon was not captured, so no icon colour is claimed
  composer-textarea:
    type: input
    backgroundColor: transparent
    textColor: '#262626'
    typography: 16px / 400 / 24px Pretendard
    size: 686px x 24px
    states: rest; in the 유튜브 요약 panel the field grows to 98px tall (interaction tab-3-2); the placeholder was not captured
    use: Chat composer text field on wrtn.ai at home::[data-omd-capture="14"]
  composer-send-button:
    type: button
    backgroundColor: '#f1f1f1'
    textColor: '#c5c5c5'
    rounded: 100%
    padding: 4px
    size: 34px x 34px
    disabled: 'bg #f1f1f1, icon colour #c5c5c5 while the composer is empty'
    states: disabled at rest; the enabled colours were not captured
    use: Send button at the right of the composer toolbar at home::[data-omd-capture="17"]
  composer-icon-button:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #f1f1f1'
    rounded: 100%
    padding: 4px
    size: 32px x 32px
    states: rest only; no state frame
    use: Round icon button at the left of the composer toolbar at home::[data-omd-capture="15"]
  role-chip:
    type: button
    backgroundColor: transparent
    border: '1px solid #f1f1f1'
    rounded: 999px
    padding: 4px 6px 4px 8px
    height: 32px
    states: rest only; no state frame
    use: 역할 chip in the composer toolbar at home::[data-omd-capture="16"], 88 x 32
  option-pill:
    type: button
    backgroundColor: transparent
    border: '1px solid #f1f1f1'
    rounded: 999px
    padding: 6px 8px
    height: 32px
    states: rest only; each declares aria-haspopup=dialog
    use: Two option pills in the 실시간 녹음 panel at home::[data-omd-interaction-capture="tab-4-2"], 76 x 32
  top-icon-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    padding: 4px
    size: 32px x 32px
    states: rest captured; its hover and pressed frames both read rgba(0, 0, 0, 0.1), but it is a single element with no sibling to agree, so no state value is declared
    use: Icon button at the top of wrtn.ai at home::[data-omd-capture="5"]
  popover-menu:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #f1f1f1'
    rounded: 16px
    padding: 12px
    shadow: rgba(0, 0, 0, 0.1) 0px 0px 15px 0px
    use: Popover opened during the collector's dialog pass (dialog-0-0 and dialog-1-0, 153 x 127); items are 127 x 32 with 12px radius and 6px 8px padding; the trigger was not recorded
  corp-news-card:
    type: card
    backgroundColor: '#f5f5f5'
    textColor: '#333333'
    rounded: 24px
    padding: 20px 24px 24px
    size: 363px x 187px
    use: 'News card (a.news-small-card) on wrtn.io at surface-3::[data-omd-capture="8"]; headline 20px / 600 / 28px #333333 with -0.2px tracking'
  corp-careers-cta:
    type: button
    backgroundColor: oklab(0.999994 0.0000455678 0.0000200868 / 0.9)
    textColor: '#333333'
    rounded: 40px
    padding: 16px 50px
    height: 56px
    typography: 16px / 600 / 24px Pretendard
    states: rest only; no state frame
    use: 채용공고 보러가기 over the dark careers band on wrtn.io at surface-3::[data-omd-capture="11"], 213 x 56; the fill is white at 0.9 alpha over a 17px backdrop blur (class names bg-white/90 and backdrop-blur-[17px])
fonts:
  roles:
    sans: Pretendard
    display: Manrope
---

# Wrtn

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wrtn; reproduced for educational reference. Full prose: https://oh-my-design.kr/wrtn/design.md
