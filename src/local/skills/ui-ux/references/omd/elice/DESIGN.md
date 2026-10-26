---
name: Elice
colors:
  primary: '#212121'
  on-primary: '#ffffff'
  ink: '#191f28'
  canvas: '#ffffff'
  slate: '#343e4b'
  muted: '#66717e'
  accent: '#7353ea'
  hairline: '#e9ebf0'
  success-tint: '#dfebe0'
  success-deep: '#1b5e20'
  tile-blue: '#2f5efb'
  tile-magenta: '#b853ea'
  tile-sky: '#03a9f4'
typography:
  display:
    fontSize: 48px
    fontWeight: 500
    lineHeight: 1.2
    use: Page title on the Cloud pricing page (h2 엘리스클라우드 요금제), Elice DX Neolli, tracking -2.4%
  section:
    fontSize: 40px
    fontWeight: 500
    lineHeight: 1.2
    use: Home statistics and section heads (h3), Elice DX Neolli, tracking -2.4%
  subsection:
    fontSize: 32px
    fontWeight: 500
    lineHeight: 1.24
    use: Pricing sub-heading (h4 Storage 요금제), Elice DX Neolli, tracking -1%
  product-label:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Product names beside the icon tiles on home, Elice DX Neolli
  body:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: Page body, card copy and footer menu links, Pretendard
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.71
    use: Header and hero action labels, Pretendard (24px line)
  button-large:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1.6
    use: Closing-band action labels, Pretendard (24px line)
  button-small:
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.69
    use: 더 보기 on the case-study cards, Pretendard (22px line)
  tab:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.25
    use: Product tabs on the pricing page, Pretendard (17.5px line)
  toggle:
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.75
    use: Selected option of the GPU, NPU and CPU switch, Pretendard; unselected options compute 500 (22.75px line)
  link:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.71
    use: 가격 문의 links in the pricing table, Pretendard (23.94px line)
  menu-label:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.4
    use: Footer menu group labels (AI 교육, AI 전환), Pretendard (19.6px line)
  badge:
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1.5
    use: Status tags (모집 중, 채용 중), Pretendard (16.5px line)
rounded:
  button: 8px
  button-large: 10px
  small: 6px
  tag: 4px
  card: 24px
  tile: 12px
spacing:
  button-y: 8
  button-x: 16
  card: 32
  menu-x: 12
  logo-gap: 32
components:
  primary-button:
    type: button
    backgroundColor: '#212121'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 16px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: rest on all three captured pages; the collector recorded no hover, pressed or focus frame for this control, so no state value is declared
    use: 무료로 시작하기 in the header of home and the pricing page at home::[data-omd-capture="8"], 120 x 40 (MuiButton-contained, colorSecondary)
    pressed: 'bg #4d4d4d (:hover + :active)'
    focus: 'bg #4d4d4d, browser default focus ring (outline auto) on :focus-visible'
  hero-primary-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#191f28'
    rounded: 8px
    padding: 8px 16px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: rest; the recorded hover and pressed frames were read while the background was still changing, so no state value is declared
    use: 무료로 시작하기 in the home hero at home::[data-omd-capture="9"], 120 x 40 (MuiButton-contained, colorPrimary)
  outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#212121'
    border: 1px rgba(33,33,33,0.5)
    rounded: 8px
    padding: 7px 15px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: rest; the recorded hover and pressed frames were read mid-change, so no state value is declared
    use: 도입문의 in the header at home::[data-omd-capture="7"], 80 x 40 (MuiButton-outlined, colorSecondary)
  hero-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 8px
    padding: 7px 15px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: rest only; no hover or pressed frame was recorded
    use: 도입문의 beside the hero action at home::[data-omd-capture="10"], 80 x 40
  nav-button:
    type: button
    backgroundColor: transparent
    textColor: '#212121'
    rounded: 8px
    padding: 8px 16px
    height: 40px
    typography: 14px / 600 / 24px Pretendard
    states: rest; the recorded hover and pressed frames were read at the start of the background change, so no state value is declared
    use: Header menu buttons (엘리스AX, 엘리스클라우드, 리소스) plus 블로그 and 로그인 at home::[data-omd-capture="1"], 103 x 40; the same style carries 더 알아보기 on home
  small-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#212121'
    rounded: 6px
    padding: 5px 12px
    height: 32px
    typography: 13px / 600 / 22px Pretendard
    states: rest only; no state frame
    use: 더 보기 on the case-study cards on home at home::[data-omd-capture="23"], 79 x 32
  large-primary-button:
    type: button
    backgroundColor: '#212121'
    textColor: '#ffffff'
    rounded: 10px
    padding: 11px 20px
    height: 46px
    typography: 15px / 700 / 24px Pretendard
    states: rest only; no state frame
    use: '무료로 시작하기 in the closing band of the pricing page at surface-2::[data-omd-capture="28"], 134 x 46; the home closing band repeats it with a #ffffff fill and #191f28 label'
  large-outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#212121'
    border: 1px rgba(33,33,33,0.5)
    rounded: 10px
    padding: 10px 19px
    height: 46px
    typography: 15px / 700 / 24px Pretendard
    states: rest only; no state frame
    use: 도입문의 beside it at surface-2::[data-omd-capture="29"], 92 x 46; white-bordered with a white label on the home closing band
  product-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#343e4b'
    rounded: 8px
    padding: 10px 8px
    height: 44px
    typography: 14px / 600 / 17.5px Pretendard
    selected: 'fg #7353ea on the Mui-selected tab (capture 9)'
    states: selected read from rest values (capture 9 against 10); the recorded hover and pressed frames are not declared because their settling was not confirmed
    use: Product tabs on the pricing page (엘리스AI클라우드, ECI) at surface-2::[data-omd-capture="10"]
  segmented-toggle:
    type: toggle
    backgroundColor: transparent
    textColor: rgba(0,0,0,0.54)
    rounded: 6px
    padding: 6px
    height: 35px
    typography: 13px / 500 / 22.75px Pretendard
    selected: 'bg #ffffff, fg #191f28, weight 700 (capture 11)'
    shadow: rgba(0, 0, 0, 0.04) 0px 4px 5px 0px, rgba(0, 0, 0, 0.04) 0px 4px 24px 0px on the selected option
    states: selected read from rest values (capture 11 against 12); no hover frame
    use: GPU, NPU and CPU switch on the pricing page at surface-2::[data-omd-capture="12"], 128 x 35 per option
  status-chip:
    type: badge
    backgroundColor: '#dfebe0'
    textColor: '#1b5e20'
    rounded: 4px
    padding: 0px 4px (label)
    height: 20px
    typography: 11px / 500 / 16.5px Pretendard
    use: 모집 중 and 채용 중 tags in the footer menu (MuiChip colorSuccess), 39 x 20; the label span computes 11px / 700
  feature-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#191f28'
    border: '1px #e9ebf0'
    rounded: 24px
    padding: 32px (content block)
    size: 522px x 353px
    use: Outlined cards near the top of home (MuiCard on an outlined Paper), no shadow
  product-icon-tile:
    type: avatar
    backgroundColor: '#7353ea'
    textColor: '#ffffff'
    rounded: 12px
    size: 32px x 32px
    use: 'Square product icon tiles beside product names on home (MuiAvatar); fills are #7353ea, #2f5efb, #b853ea and #03a9f4 by product, and the footer menu repeats them at 24 x 24 with a 6px radius'
  footer-menu-item:
    type: listItem
    backgroundColor: transparent
    textColor: '#191f28'
    rounded: 4px
    padding: 8px 12px
    height: 40px
    typography: 16px / 500 / 24px Pretendard
    states: rest only; no state frame
    use: Footer menu links (엘리스LXP, 엘리스테스트, 런박스 and the rest) at home::[data-omd-capture="90"], 237 x 40; group labels (AI 교육, AI 전환) at capture 89 read rgba(25,31,40,0.38), 14px / 400
fonts:
  roles:
    display: Elice DX Neolli
    body: Pretendard
---

# Elice

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Elice; reproduced for educational reference. Full prose: https://oh-my-design.kr/elice/design.md
