---
name: Ably
colors:
  primary: '#ff5160'
  canvas: '#ffffff'
  foreground: '#1f1f1f'
  consumer-secondary: '#777777'
  team-secondary: '#757575'
  seller-body: '#5b5b5b'
  consumer-border: '#dddddd'
  platform-border: '#e5e7eb'
  team-accent-surface: '#fff2ea'
typography:
  consumer-label:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.4px'
    use: Current mobile consumer labels
  consumer-compact:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.2px'
    use: Mobile-web app-entry label as captured 2026-07-12; the rebuilt control measured 2026-09-29 renders a 10px / 400 label
  consumer-meta:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.27
    use: Current mobile consumer metadata
  corporate-display:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.3px'
    use: Current ABLY Team display heading
  corporate-section:
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: '-0.3px'
    use: Current ABLY Team repeated section heading
  corporate-card:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: '-0.3px'
    use: Current ABLY Team card heading
  corporate-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: '-0.3px'
    use: Current ABLY Team body and card copy
  seller-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Current Seller Square body and navigation text
rounded:
  corporate-control: 12px
  pill: 24px
  consumer-action: 20px
  full: 9999px
spacing:
  xs: 8
  sm: 10
  md: 16
  lg: 24
  xl: 32
components:
  consumer-open-app:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    rounded: 20px
    padding: 0px 8px
    size: 62px x 28px
    typography: 10px / 400 (visible label; the pressable itself computes 16px / 400 Pretendard-Regular)
    hover: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: 'captured 2026-07-12 as a bordered button (1px #dddddd, 12px / 600 label); re-measured 2026-09-29 as a React Native Web pressable with no border on the control or its 3 ancestors and a 10px / 400 label; hover, pressed and keyboard focus measured 2026-09-29 (Tab 1); transition all 0s'
    use: Mobile-web app-install banner action 앱에서 보기, reached through the declared m.a-bly.com redirect to mobile.a-bly.com
  corporate-primary:
    type: button
    backgroundColor: '#ff5160'
    textColor: '#ffffff'
    rounded: 12px
    size: 160px x 56px
    typography: 18px / 600
    hover: 'bg #db3b57'
    pressed: 'bg #db3b57'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the floating 채용공고 보러가기 button (Tab 26); pressed equals hover; transition all 0s
    use: Current ABLY Team primary action
    height: 56px
    padding: 0px
  corporate-soft-action:
    type: button
    backgroundColor: '#fff2ea'
    textColor: '#ff5160'
    rounded: 12px
    size: 312px x 48px
    typography: 16px / 600
    hover: 'bg #ffe5dc'
    pressed: 'bg #ffe5dc'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on 새소식 더보기, a button inside a link (Tab 10); pressed equals hover; transition all 0s
    use: Current ABLY Team low-emphasis action
  corporate-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#4e4e4e'
    rounded: 24px
    padding: 14px 16px
    size: 105px x 48px
    typography: 16px / 400
    hover: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on 자세히 보기 (Tab 7); the shadowed carousel item around it (corporate-card) is inside the compared ancestor levels and did not change either
    use: Current ABLY Team compact editorial action
  corporate-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    rounded: 12px
    shadow: 0 4px 48px rgba(0,0,0,0.08)
    states: 'not a control: a list item with no Tab stop; read 2026-09-29 as an ancestor of corporate-pill, where hover and press changed nothing on it'
    use: 'Non-interactive ABLY Team card: the white mission cards and the image carousel list item that holds the 자세히 보기 pill. The shadow is on the list item, not on a link; the clickable news story is team-story-card'
  seller-primary:
    type: button
    backgroundColor: '#ff5160'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 13px 30px
    size: 114px x 49px
    typography: 16px / 400 / Noto Sans Korean (visible label span; the link itself computes 14px / 400)
    hover: 'bg #bf3c47'
    pressed: 'bg #bf3c47'
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on My 마켓 (Tab 8); pressed equals hover; transition all 0.3s
    use: Current Seller Square primary entry action
  consumer-category-chip:
    type: tab
    backgroundColor: transparent
    textColor: '#777777'
    border: '1px solid #dddddd'
    rounded: 18px
    padding: 9px 12px
    size: 48px x 36px
    typography: 13px / 400 (visible label; the pressable itself computes 16px / 400 Pretendard-Regular)
    hover: no change in the compared scope (self, its ::before/::after, 2 descendants, 3 ancestor levels) — measured 2026-09-29
    pressed: 'bg #eeeeee'
    focus: outline browser default ring (outline-style auto), not brand — measured 2026-09-29
    states: unselected chip 상의; hover, pressed and keyboard focus measured 2026-09-29 (Tab 88); the fill appears on press only, with no hover change; transition all 0s; the selected chip was not read
    use: Consumer mobile-web category chip row (상의 and its siblings) on mobile.a-bly.com, reached through the declared m.a-bly.com redirect; the mobile web renders as a 600px column at desktop width
  team-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#1f1f1f'
    rounded: 24px
    padding: 14px 16px
    size: 76px x 48px
    typography: 16px / 600 / Pretendard
    hover: bg rgba(0,0,0,0.05)
    pressed: bg rgba(0,0,0,0.05)
    focus: outline browser default ring (outline-style auto, offset 1px), not brand — measured 2026-09-29
    states: default, hover, pressed and keyboard focus measured 2026-09-29 on 팀 문화 (Tab 3); pressed equals hover; transition all 0s; a menu it may open would be a sibling and was not compared
    use: ABLY Team fixed header link (팀 문화 and its siblings)
  team-story-card:
    type: card
    backgroundColor: transparent
    textColor: '#1f1f1f'
    rounded: 0px
    size: 464px x 544px
    typography: '24px / 600 / Pretendard (story title; the meta line is 16px / 400 #757575)'
    hover: transform matrix(1.05, 0, 0, 1.05, 0, 0) on the card image (scale 1.05); the link itself does not change
    pressed: transform matrix(1.05, 0, 0, 1.05, 0, 0) on the card image, as on hover
    focus: outline browser default ring (outline-style auto, offset 1px), not brand — measured 2026-09-29
    states: default captured 2026-07-12 (two 464 x 544 story items); hover, pressed and keyboard focus measured 2026-09-29 on the first story link (Tab 11); the image transition is 400 ms; the link has no radius and no shadow
    use: 'ABLY Team news story card: one link wrapping image, title and meta. It is not corporate-card, whose shadow sits on non-interactive list items'
  team-news-row:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#1f1f1f'
    rounded: 12px
    padding: 16px
    size: 960px x 104px
    typography: '24px / 600 / Pretendard (row title; the date line is 18px / 400 #757575)'
    states: default captured 2026-07-12 (two rows); not probed
    use: ABLY Team news row list above the 새소식 더보기 soft action
  seller-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#1f1f1f'
    rounded: 0px
    padding: 0px 17px
    size: 104px x 90px
    typography: 18px / 700 / Noto Sans Korean
    hover: 'fg #ff5160'
    pressed: 'fg #ff5160'
    focus: no focus indication in the compared scope (self, its ::before/::after, 1 descendant, 3 ancestor levels) — measured 2026-09-29
    states: default, hover, pressed and keyboard focus measured 2026-09-29 on 입점 소개 (Tab 2); the label span turns with the link; transition all 0.3s; a dropdown it may open is a sibling and was not compared
    use: Seller Square header navigation item (입점 소개 and its siblings), 90px tall
fonts:
  roles:
    consumer: Pretendard
    corporate: Pretendard
    seller: Noto Sans Korean
---

# Ably

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ably; reproduced for educational reference. Full prose: https://oh-my-design.kr/ably/design.md
