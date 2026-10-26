---
name: 숲
colors:
  primary: '#0182ff'
  surface-subtle: '#f6f6f9'
  foreground: '#17191c'
  muted: '#757b8a'
  chip-surface: '#e8ebed'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 16.8px
    use: Repeated public-home text and the measured search input; the loaded product family is Pretendard.
  list-title:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 18px
    use: Observed public-home title and metadata samples only; no complete display scale is claimed.
rounded:
  search-input: 45px
  chip: 30px
spacing:
  search-input-inline-start: 16
  search-input-inline-end: 70
  chip-inline: 8
components:
  home-search-input:
    type: input
    backgroundColor: '#f6f6f6'
    textColor: '#525661'
    rounded: 45px
    padding: 0px 70px 0px 16px
    height: 45px
    typography: 14px / 400 / 16.8px / Pretendard
    states: default on both home snapshots; the bundle holds no state frame for any element, so hover, focus, and pressed values are not recorded; no disabled or error variant was observed
    use: Repeated public-home input, selectors home::[data-omd-capture="2"] and surface-2::[data-omd-capture="2"].
  home-tag-chip:
    type: badge
    backgroundColor: '#f6f6f9'
    textColor: '#757b8a'
    rounded: 30px
    padding: 0px 8px
    height: 20px
    typography: 12px / 400 / 20px Pretendard
    states: default on 86 chips on the home snapshot and 21 on esports (surface-3 capture 182); the bundle holds no state frame
    use: Broadcast-card tag chip (a) at home::[data-omd-capture="65"]
  home-category-chip:
    type: badge
    backgroundColor: '#e8ebed'
    textColor: '#757b8a'
    rounded: 30px
    padding: 0px 8px
    height: 20px
    typography: 12px / 400 / 20px Pretendard
    states: default on 42 chips on the home snapshot and 6 on esports (surface-3 capture 181); the bundle holds no state frame
    use: Broadcast-card category chip (a.category) at home::[data-omd-capture="57"]
  home-profile-avatar:
    type: avatar
    border: 1px rgba(117, 123, 138, 0.2)
    rounded: 50%
    size: 38px x 38px
    states: default on 24 avatars on the home snapshot and 6 on esports (surface-3 capture 178); the bundle holds no state frame
    use: Broadcast-card profile image link (a.thumb) at home::[data-omd-capture="54"]; it holds no text, so no label style is claimed
  home-nickname-link:
    type: button
    textColor: '#17191c'
    height: 18px
    typography: 14px / 600 / 18px Pretendard
    states: default on 24 links on the home snapshot and 6 on esports (surface-3 capture 179); the bundle holds no state frame
    use: Broadcast-card creator nickname link (a.nick) at home::[data-omd-capture="55"]
  home-broadcast-title-link:
    type: button
    textColor: '#17191c'
    height: 42px
    typography: 15px / 400 / 21px Pretendard
    states: default on 24 links on the home snapshot and 6 on esports (a.title, surface-3 capture 180); the bundle holds no state frame
    use: Broadcast-card title link (a) at home::[data-omd-capture="56"], two 21px lines high
  home-broadcast-thumbnail:
    type: card
    backgroundColor: '#f1f2f4'
    rounded: 16px
    size: 271px x 152px
    states: default on 16 frames at 271 x 152 and 8 at 272 x 153 on the home snapshot; esports (a.thumb-default, surface-3 capture 177) records the same fill and radius at 220 x 124; the bundle holds no state frame
    use: 'Broadcast thumbnail frame (a) at home::[data-omd-capture="53"]: the fill sits behind the image and a bottom padding (152.156px) sets the height; it holds no text, so no label style is claimed'
  home-content-card:
    type: card
    backgroundColor: '#f6f6f9'
    rounded: 15px
    size: 369px x 110px
    states: default on 15 cards on the home snapshot; the bundle holds no state frame
    use: Home content-link card (a) at home::[data-omd-capture="30"]; its own text colour and type equal the page body (#000000, 12px / 400 / 14.4px), so it is treated as a container and no label style is claimed
  home-alarm-button:
    type: button
    backgroundColor: '#fcfcfd'
    rounded: 0px 0px 30px 30px
    size: 30px x 29px
    shadow: rgba(0, 0, 0, 0.05) 0px 1px 1px 0px
    states: default on 7 buttons on the home snapshot; the bundle holds no state frame
    use: Alarm button (button.alarm) in the content-link card row at home::[data-omd-capture="33"]; its font size is 0px, so no label style is claimed
  home-live-button:
    type: button
    backgroundColor: '#ff2f00'
    textColor: '#fcfcfd'
    rounded: 30px
    padding: 0px 7px
    height: 20px
    typography: 11px / 500 / 21px Pretendard
    states: default on one button on the home snapshot; the bundle holds no state frame
    use: Live marker button (button.live) in the content-link card row at home::[data-omd-capture="31"], 36 x 20; its four-character label is set in the button itself
  home-login-button:
    type: button
    backgroundColor: transparent
    textColor: '#525661'
    rounded: 6px
    padding: 0px 6px
    height: 40px
    typography: 15px / 400 / 18px Pretendard
    states: 'default on the home header; the esports header button (surface-3 capture 7) records fg #d5d7dc with the same geometry and type; the bundle holds no state frame'
    use: Header login button (button.btn-login) at home::[data-omd-capture="6"], 51 x 40
  home-banner-thumb-tab:
    type: tab
    backgroundColor: transparent
    rounded: 14px
    padding: 6px
    size: 260px x 72px
    selected: bg rgba(255, 255, 255, 0.1)
    states: rest on three items of a four-item vertical rail; the item with class swiper-slide-thumb-active (the rail marker for the banner slide on show) differs from them by its fill and is recorded as selected; the first item carries the positional class swiper-slide-active and records the transparent rest fill; the bundle holds no state frame
    use: Home banner thumbnail rail item (li.swiper-slide) beside the banner player; radius, padding and size sit on the li
  esports-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    border: 2px transparent on the bottom edge
    padding: 0px 6px
    height: 68px
    typography: 16px / 600 / normal Pretendard
    states: 'rest on six links (capture 11-16); capture 10 in the same row records fg #0182ff and a 2px #0182ff bottom border, but the capture gives it no aria-selected or class, so no selected value is declared; the bundle holds no state frame'
    use: Esports header navigation link (a) at surface-3::[data-omd-capture="11"]
  esports-filter-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#525661'
    border: '1px #e2e4e9'
    rounded: 18px
    padding: 0px 14px
    height: 35px
    typography: 15px / 400 / normal Pretendard
    states: 'rest on 29 buttons; capture 107, first in the row of capture 108, records bg #17191c, fg #ffffff and no border, but the capture gives it no aria-selected or class, so no selected value is declared; the bundle holds no state frame'
    use: Esports outline pill button at surface-3::[data-omd-capture="108"], 82 x 35
  esports-status-badge:
    type: badge
    backgroundColor: '#e2e4e9'
    textColor: '#acb0b9'
    rounded: 6px
    padding: 0px 6px
    height: 22px
    typography: 13px / 400 / 22px Pretendard
    states: default on four badges (capture 236-239); the bundle holds no state frame
    use: Esports status label (a.staus) at surface-3::[data-omd-capture="236"], 59 x 22
  esports-accent-button:
    type: button
    backgroundColor: '#fcfcfd'
    textColor: '#0182ff'
    border: 1px rgba(117, 123, 138, 0.2)
    rounded: 18px
    padding: 0px 31px
    height: 36px
    typography: 13px / 500 / normal Pretendard
    states: default on one button; the bundle holds no state frame
    use: Esports outline button with a blue label at surface-3::[data-omd-capture="228"], 141 x 36
fonts:
  roles:
    ui: Pretendard
---

# 숲

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 숲; reproduced for educational reference. Full prose: https://oh-my-design.kr/soop/design.md
