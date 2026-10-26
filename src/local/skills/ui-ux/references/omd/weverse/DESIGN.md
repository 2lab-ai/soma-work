---
name: Weverse
colors:
  primary: '#00cbd5'
  primary-text: '#00b8c1'
  ink: '#000000'
  canvas: '#ffffff'
  shop-ink: '#202429'
  shop-heading: '#111111'
  shop-body: '#484848'
  muted: '#8e8e8e'
  hairline: '#ebedf2'
typography:
  banner-title:
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.29
    use: Headline on the Weverse Shop home's banner slides, white over imagery or black on light slides
  artist-name:
    fontSize: 24px
    fontWeight: 800
    lineHeight: 1.29
    use: Artist names over artist cards on the Weverse Shop home, white
  section:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.28
    use: Section headings on the Weverse Shop home
  list-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.38
    use: Titles of the recommended DM and featured-community lists on weverse.io
  shop-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Body text on Weverse Shop (line height computes 16px)
  tab:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.29
    use: Category tabs on Weverse Shop and DM chips on weverse.io
  button:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.29
    use: 로그인 label on weverse.io and the full-width outlined pill on Weverse Shop
  prompt:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.29
    use: Sign-in prompt in the global menu on weverse.io, grey
  meta:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.31
    use: Product meta lines under Weverse Shop products
  body:
    fontSize: 13px
    fontWeight: 400
    use: Body text on weverse.io (line height computes normal)
  badge:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.27
    use: Artist-name badge on weverse.io banner slides
rounded:
  control: 8px
  card: 16px
  float: 18px
  pill: 100px
spacing:
  control-x: 16
  menu-y: 12
  menu-x: 16
  card: 16
components:
  login-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#00b8c1'
    border: '1px solid #00cbd5'
    rounded: 8px
    padding: 0px 16px
    height: 36px
    typography: 14px / 700 / 18px Pretendard
    states: rest only; not probed, because a press opens sign-in; the collector recorded no state frame for it
    use: '로그인 in the global menu''s sign-in block under the prompt 로그인하고 나만의 아티스트를 만나보세요! at home::[data-omd-capture="3"], 70 x 36; the label span also computes #00b8c1; its own class is button-_--secondary1; the only teal on a product action across the three captured pages (the artist shop''s cookie bar renders a separate teal, #08ccca, on its 전체 동의 label)'
  global-menu-item:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 8px
    padding: 12px 16px
    height: 48px
    typography: 13px / 400 Pretendard
    hover: 'bg #ffffff'
    pressed: 'bg #ffffff'
    states: 'hover and pressed both read bg #ffffff on all seven sibling items (captures 4-10), a full step from transparent to a clean value, so both are declared; focus is not declared'
    use: Items of the global menu on weverse.io at home::[data-omd-capture="4"], 225 x 48; labels were not read
  shop-tab:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #ebedf2'
    rounded: 100px
    padding: 0px 16px
    height: 36px
    typography: 14px / 500 / 18px Pretendard
    selected: 'bg #000000, fg #ffffff, border 1px solid #000000 (capture 170, aria-selected true)'
    states: selected read from rest values; the collector's interaction pass activated three tabs (captures 171-173) and each became selected; no pointer frame
    use: Category tabs on Weverse Shop at surface-2::[data-omd-capture="171"]; on the BTS artist shop they read NEW, Merch, Tour Merch, BT21, Album and Global Membership
  shop-carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#202429'
    border: 1px solid rgba(0, 0, 0, 0.1)
    rounded: 100px
    height: 36px
    disabled: the collector recorded a disabled state in this group of 18 instances; no separate disabled colour was isolated
    states: rest and disabled at capture; no pointer frame
    use: Previous and next arrows of the carousels on the Weverse Shop home at surface-2::[data-omd-capture="49"], 36 x 36
  banner-arrow:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.2)
    textColor: '#ffffff'
    border: 1px solid rgba(0, 0, 0, 0.04)
    rounded: 100px
    height: 36px
    states: rest only; the collector recorded no state frame for it
    use: Round controls of the weverse.io banner carousel at home::[data-omd-capture="22"], 36 x 36
  community-badge:
    type: badge
    backgroundColor: rgba(255, 255, 255, 0.04)
    textColor: '#ffffff'
    border: 1px solid rgba(255, 255, 255, 0.2)
    rounded: 100px
    padding: 0px 8px
    height: 24px
    typography: 11px / 700 / 14px Pretendard
    use: 'Artist-name badge on dark weverse.io banner slides (home::div, 81 x 24); a second variant reads rgba(0, 0, 0, 0.04) fill, #000000 text and a rgba(0, 0, 0, 0.2) border'
  dm-chip:
    type: badge
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 100px
    padding: 0px 20px 0px 6px
    height: 44px
    typography: 14px / 500 / 18px Pretendard
    shadow: rgb(235, 237, 242) 0px 0px 0px 1px inset
    use: Recommended Weverse DM chips on weverse.io (home::span, chips-_-wrapper), 133 x 44, a 32px round avatar followed by the artist name
  community-row:
    type: listItem
    textColor: '#000000'
    height: 76px
    use: Featured-community rows on weverse.io at home::[data-omd-capture="35"], 516 x 76, each led by a 72 x 72 avatar
  shop-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#202429'
    rounded: 16px
    padding: 16px
    shadow: rgba(0, 0, 0, 0.12) 0px 4px 28px 0px
    use: Raised white panel on the Weverse Shop home (surface-2::article, 1080 x 202) and the artist shop's side panels (713 and 347 wide)
  shop-outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: 1px solid rgba(0, 0, 0, 0.2)
    rounded: 100px
    padding: 0px 16px
    height: 36px
    typography: 14px / 700 / 18px Pretendard
    states: rest only; no state frame
    use: Full-width outlined pill on the Weverse Shop home at surface-2::[data-omd-capture="37"], 1048 x 36; its label was not read
fonts:
  roles:
    sans: Pretendard
---

# Weverse

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Weverse; reproduced for educational reference. Full prose: https://oh-my-design.kr/weverse/design.md
