---
name: MyRealTrip
colors:
  primary: '#2b96ed'
  canvas: '#ffffff'
  ink: '#495056'
  muted: '#666d75'
  search-fill: '#f5f6f7'
  control-border: '#ced4da'
  selected-fill: '#101418'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
    use: Public hotel-listing body/list text
  control:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 22.5px
    use: Public hotel-search input
rounded:
  square: 0px
  action: 12px
  selected-tab: 16px
spacing:
  action-inline: 24
components:
  primary-header-action:
    type: button
    backgroundColor: '#2b96ed'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0px 24px
    height: 40px
    typography: 14px / 600 / Pretendard
    states: 'Default only; the bundle holds no hover, pressed, or focus frame on any of its three surfaces, so none is claimed, and no disabled variant was observed. Corrected 2026-09-29: the July text reasoned from interactionCount 0, which counts expansions, not pointer states.'
    use: Public home and hotel-header action; home::[data-omd-capture="5"] and surface-3::[data-omd-capture="3"]
    pressed: 'bg #51abf3 (:hover + :active)'
    focus: no visible change (measured 2026-10-16) on :focus-visible
  selected-locale-tab:
    type: tab
    backgroundColor: '#101418'
    textColor: '#ffffff'
    rounded: 16px
    padding: 6px 10px
    height: 32px
    typography: 15px / 700 / Pretendard
    active: aria-selected=true observed on home::[data-omd-capture="1"]
    use: Selected locale tab on the public home header
  search-input:
    type: input
    backgroundColor: '#f5f6f7'
    textColor: '#495056'
    rounded: 0px
    padding: 0px 54px 0px 20px
    height: 48px
    typography: 15px / 500 / 22.5px Pretendard
    states: default captured on hotel listing (326 x 48) and home (345 x 48); no focus or error sample; no state frame (the bundle holds none on any of its three surfaces)
    use: Public keyword search input (SearchInput--KeywordInput) at surface-3::[data-omd-capture="1"] and home::[data-omd-capture="3"]; its border width is 0px, so no field frame is claimed; home renders it in the loaded alias __pretandard_7bdbf6 with normal line height
  outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#495056'
    border: '1px #ced4da'
    rounded: 4px
    padding: 9px 8px
    height: 40px
    typography: 14px / 700 / 21px Pretendard
    states: default captured on hotel listing and home (140 x 40 on both); no state frame (the bundle holds none on any of its three surfaces)
    use: Footer customer-centre outline button (button.mrt-button) at surface-3::[data-omd-capture="15"] and home::[data-omd-capture="23"]
  header-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#666d75'
    rounded: 3px
    padding: 8px 12px
    height: 39px
    typography: 15px / 600 / 22.5px Pretendard
    states: default captured on hotel listing (105 x 39) and home (105 x 34, normal line height); no state frame (the bundle holds none on any of its three surfaces)
    use: Header text button (GlobalNavNonLineButton) beside the blue header action at surface-3::[data-omd-capture="2"] and home::[data-omd-capture="4"]
  footer-sitemap-link:
    type: tab
    backgroundColor: transparent
    textColor: '#666d75'
    rounded: 4px
    padding: 6px
    height: 33px
    typography: 14px / 400 / 21px Pretendard
    states: default captured on nine links per surface (hotel capture 16-24; home capture 24-32, 29px high with normal line height); no state frame (the bundle holds none on any of its three surfaces)
    use: Footer sitemap link (SiteMapItems--MenuLink) at surface-3::[data-omd-capture="16"] and home::[data-omd-capture="24"]
  footer-policy-link:
    type: tab
    backgroundColor: transparent
    textColor: '#666d75'
    rounded: 4px
    padding: 6px
    height: 44px
    typography: 14px / 400 / 21px Pretendard
    states: default captured (hotel capture 25-27; home capture 33-36, 56px high); one link per row (hotel capture 26, home capture 34) carries a different generated class and renders 14px / 700, a fixed emphasis rather than a state; no state frame (the bundle holds none on any of its three surfaces)
    use: Footer policy link row (PolicyList--Link) at surface-3::[data-omd-capture="25"] and home::[data-omd-capture="33"]
  footer-select-button:
    type: button
    backgroundColor: '#ffffff'
    border: '1px #ced4da'
    rounded: 4px
    padding: 0px 10px
    size: 118px x 40px
    states: default captured on hotel listing and home; no state frame (the bundle holds none on any of its three surfaces)
    use: 'Footer select popup button (DesktopSelect--PopupButton) at surface-3::[data-omd-capture="34"] and home::[data-omd-capture="43"]; its own computed colour differs by surface (#373a3c on hotel listing, #000000 on home) and its own type is 10px on hotel listing and the browser-default 13.3333px on home, so the label sits on an uncaptured child and no label style is claimed'
  home-white-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#343a40'
    rounded: 0px
    padding: 0px
    height: 38px
    typography: 15px / 600
    states: default captured on two buttons (capture 46-47, 162 x 38); no state frame (the bundle holds none on any of its three surfaces)
    use: Home white button pair at home::[data-omd-capture="46"]; the bundle does not record their role; the family is the loaded alias __pretandard_7bdbf6
  home-blue-text-link:
    type: tab
    backgroundColor: transparent
    textColor: '#2b96ed'
    rounded: 0px
    padding: 0px
    height: 16px
    typography: 14px / 500
    states: default captured on three links (capture 19-21); no state frame (the bundle holds none on any of its three surfaces)
    use: Home blue text link at home::[data-omd-capture="19"]; the family is the loaded alias __pretandard_7bdbf6
  about-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#374151'
    rounded: 12px
    padding: 8px 12px
    height: 32px
    typography: 14px / 500 / 20px
    states: default captured on six links (capture 1-6); no state frame (the bundle holds none on any of its three surfaces)
    use: Corporate about-site header link at surface-2::[data-omd-capture="1"] (about.myrealtrip.com); corporate chrome, not consumer product evidence; its stack leads with Pretendard Variable, which the bundle lists as declared-only, so no family is claimed
  about-nav-pill:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 12px
    padding: 8px 12px
    height: 36px
    typography: 14px / 500 / 20px
    states: default captured; no state frame (the bundle holds none on any of its three surfaces)
    use: Corporate about-site black header pill at surface-2::[data-omd-capture="7"], 76 x 36; corporate chrome; no family claimed (declared-only Pretendard Variable)
  about-footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#666666'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 14px / 400 / 20px
    states: default captured on four links (capture 8-11); the class list names a Tailwind hover utility, but a class name is not a measurement, so no hover value is declared; no state frame (the bundle holds none on any of its three surfaces)
    use: Corporate about-site footer link at surface-2::[data-omd-capture="8"]; corporate chrome; no family claimed
fonts:
  roles:
    sans: Pretendard
---

# MyRealTrip

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MyRealTrip; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/myrealtrip/DESIGN.md
