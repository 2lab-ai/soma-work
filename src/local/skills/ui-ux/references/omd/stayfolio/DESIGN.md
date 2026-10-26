---
name: Stayfolio
colors:
  primary: '#000000'
  on-primary: '#ffffff'
  ink: '#181818'
  heading: '#171719'
  nav: '#1a1a1a'
  secondary: '#767676'
  meta: '#6b6b6e'
  base-price: '#979799'
  discount: '#0199f8'
  last-minute: '#017bc6'
  footer-chip: '#595959'
  journal-text: '#333333'
  journal-muted: '#898989'
  journal-number: '#c0c0c0'
  hairline: '#dfe0e2'
  skeleton: '#f2f2f2'
  canvas: '#ffffff'
typography:
  section:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.29
    letterSpacing: '-0.56px'
    use: Home section heading (h2, class title-28-sb)
  stay-name:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: '-0.2px'
    use: Stay name on home cards (class label-16-sb)
  price:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.44
    letterSpacing: '-0.54px'
    use: Stay price; the discount rate beside it is 700
  nav:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Uppercase top navigation (FIND STAY, PROMOTION, JOURNAL, PRE-ORDER)
  button:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.5
    use: 지도 action label
  subtitle:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Home section subtitle (class label-16-rg)
  toggle:
    fontSize: 15px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: 0.21px
    use: Selected 국내 / 해외 label; the unselected label is 600
  meta:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Region and capacity line on stay cards
  badge:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: 0.24px
    use: Photo badge label
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    letterSpacing: 0.12px
    use: Footer outline buttons (class caption-12-rg)
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1
    use: Body default (line height computes to 14px)
  journal-title:
    fontSize: 21px
    fontWeight: 400
    lineHeight: 1.5
    use: Magazine card title on the journal page
  journal-tab:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.83
    use: Journal section tabs; Latin labels in Lato-Light, the selected one in Lato-Bold
rounded:
  xs: 4px
  sm: 5px
  md: 8px
  lg: 10px
  button: 20px
  pill: 100px
spacing:
  badge-y: 4
  badge-x: 8
  button-y: 8
  button-x: 16
  toggle-y: 6
  toggle-inner: 12
  toggle-outer: 16
  caption-y: 4
  caption-x: 8
  journal-frame: 15
components:
  nav-menu-button:
    type: tab
    backgroundColor: transparent
    textColor: '#1a1a1a'
    border: 2px solid transparent (bottom only)
    height: 26px
    typography: 16px / 600 / 24px Pretendard
    hover: 'bottom border 2px solid #1a1a1a'
    pressed: 'bottom border 2px solid #1a1a1a'
    selected: 'bottom border 2px solid #1a1a1a on the current section (FIND STAY on the listing, JOURNAL on the journal)'
    states: rest, hover, pressed and selected; all eleven unselected items on the three pages turn the bottom edge solid in both frames, and the current section keeps it at rest (surface-2 capture 1, surface-3 capture 4); focus is not declared from the capture
    use: Uppercase top navigation (FIND STAY, PROMOTION, JOURNAL, PRE-ORDER) at home::[data-omd-capture="4"]
  region-toggle:
    type: toggle
    backgroundColor: rgba(255, 255, 255, 0.24)
    textColor: '#171719'
    border: '1px solid #dfe0e2'
    rounded: 100px
    height: 44px
    padding: 6px 12px 6px 16px
    shadow: rgba(0, 0, 0, 0.08) 0px 4px 8px 0px
    selected: 'a #171719 thumb (62 x 42, 100px radius, rgba(0, 0, 0, 0.12) 0px 4px 12px 0px) under a white 15px / 700 label'
    states: 'selected segment read from rest values (국내 selected, 해외 at 15px / 600 #171719); no pointer frame'
    use: 국내 / 해외 switch in the home header at home::[data-omd-capture="1"], 120 x 44; padding is per segment
  map-button:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 20px
    padding: 8px 16px
    height: 40px
    typography: 16px / 500 / 24px Pretendard
    shadow: rgba(26, 26, 26, 0.1) 0px 2px 6px 0px
    states: rest only; no state frame
    use: 지도 (map view) action floating over the FIND STAY listing at surface-2::[data-omd-capture="12"], 86 x 40 — the only filled action on the captured pages
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  stay-badge:
    type: badge
    backgroundColor: rgba(26, 26, 26, 0.6)
    textColor: '#ffffff'
    rounded: 5px
    padding: 4px 8px
    height: 24px
    typography: 12px / 500 / 16px Pretendard
    use: Overlay labels on stay photographs on home (페스타, 프로모션, 단독소개); the white label is a child span with 0.24px tracking
  last-minute-badge:
    type: badge
    backgroundColor: '#017bc6'
    textColor: '#ffffff'
    rounded: 5px
    padding: 4px 8px
    height: 24px
    typography: 12px / 500 / 16px Pretendard
    use: 마감할인 (last-minute discount) overlay on stay photographs, five on home
  stay-card:
    type: card
    textColor: '#171719'
    size: 411px x 378px
    use: 'Stay card on home at home::[data-omd-capture="11"]: photograph with overlay badges, name 16px / 600 / 24px, region and capacity 13px / 400 in #6b6b6e, price 18px / 600 with the discount rate in 18px / 700 #0199f8 and the struck base price 13px / 500 in #979799; no card border, fill or shadow'
  listing-photo:
    type: card
    rounded: 10px
    size: 389px x 260px
    use: Photo slider at the top of each FIND STAY listing card (twenty captured)
  skeleton:
    type: card
    backgroundColor: '#f2f2f2'
    rounded: 8px
    use: Loading placeholders on the FIND STAY listing (a 389 x 260 photo block, a 90 x 24 title and region lines), captured while the list was still loading
  footer-chip:
    type: button
    backgroundColor: transparent
    textColor: '#595959'
    border: '1px solid #767676'
    rounded: 4px
    padding: 4px 8px
    height: 26px
    typography: 12px / 400 / 16px Pretendard
    states: rest only on three siblings per page; no state frame
    use: Small outline buttons in the footer beside the customer-centre hours at surface-2::[data-omd-capture="13"]
  journal-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#898989'
    height: 33px
    typography: 18px / 400 / 33px Lato-Light
    selected: 'fg #000000 in Lato-Bold (MAGAZINE on the magazine page, capture 10)'
    states: selected variant read from rest values (capture 10 against captures 8, 9 and 11); no pointer frame
    use: Journal section tabs (나의 스테이 답사기, TRAVEL, MAGAZINE, PICK) at surface-3::[data-omd-capture="9"]; the hangul tab renders in the Pretendard stack
  journal-card:
    type: card
    border: '15px solid #ffffff'
    size: 664px x 683px
    use: 'Magazine card on the journal page: issue number in DroidSerif-Italic 27px #c0c0c0, title 21px / 400 / 31.5px #333333, and a more link in Abel 14px / 400 / 30px with 1.3px tracking in #000000 over a 1px rule'
fonts:
  roles:
    sans: Pretendard
---

# Stayfolio

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Stayfolio; reproduced for educational reference. Full prose: https://oh-my-design.kr/stayfolio/design.md
