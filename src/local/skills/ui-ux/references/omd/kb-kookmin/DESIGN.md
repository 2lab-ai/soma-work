---
name: KB국민은행
colors:
  canvas: '#ffffff'
  foreground: '#333333'
  foreground-strong: '#000000'
  muted: '#5a5a5a'
  header-accent: '#ffcc00'
  link: '#0c4ad1'
  hairline: '#dddddd'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 21px
    use: Repeated public-home list and text samples; the computed family begins 맑은 고딕 but has no matching loaded FontFace in the supplied evidence.
  section-heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 26px
    use: Observed public-home h2 samples only; no complete display scale is claimed.
  online-selected-item:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 14px
    use: Inherited page text on the online-banking carousel pagination dot container (li#slick-slide00, aria-selected true; its unselected sibling records the same values); not a measured label style. The computed Roboto stack is system evidence, not a KB family.
rounded:
  square: 0px
spacing:
  inline-link-left: 9
  inline-link-right: 8
  outline-link-inline: 10
  toggle-inline: 12
components:
  home-outline-list-item:
    type: listItem
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #dddddd'
    rounded: 0px
    padding: 0px 10px
    height: 28px
    typography: 14px / 400 / unresolved computed stack
    use: Static public-home anchor samples home::[data-omd-capture=14] and 15, mapped to listItem because no button semantics are evidenced; two sibling text-color values were observed.
  home-inline-list-item:
    type: listItem
    textColor: '#0c4ad1'
    rounded: 0px
    padding: 0px 8px 0px 9px
    height: 24px
    typography: 13px / 400 / unresolved computed stack
    use: 'Static public-home footer anchor home::[data-omd-capture=67] (a.fot_p_txt), the emphasised exception among fourteen footer links; the other thirteen record #333333 (footer-link). Mapped to listItem because no button semantics are evidenced.'
  online-selected-list-item:
    type: listItem
    rounded: 0px
    padding: 0px
    height: 28px
    states: 'aria-selected true on #slick-slide00; its sibling #slick-slide01 (aria-selected false) records the same captured values, so the selected look is not among the captured properties; no state frame'
    use: 'Carousel pagination dot (li, role presentation) in ul.slick-dots (role tablist) on the online-banking route, surface-2::#slick-slide00, 18 x 28; its #333333 14px / 400 / 14px is page text inherited by a container, and its child button (surface-2::[data-omd-capture="12"]) records browser-default 13.3333px type behind an 18px left padding, so no label style is claimed'
  header-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#434343'
    rounded: 0px
    padding: 0px 8px
    height: 30px
    typography: 14px / 400 / 30px / unresolved computed stack
    states: 'rest on ten header links (capture 4-13): capture 7-13 record #434343 and the first three (capture 4-6) record #000000 with the same type; neither group carries aria-selected; the bundle holds no state frame for any KB국민은행 element'
    use: Public-home header menu link (a) at home::[data-omd-capture="7"], tracking -1px; capture 11 and 12 add 24px right padding, and capture 13 is a 30 x 30 link whose label is pushed out by 30px left padding
  home-quick-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px 19px
    height: 42px
    typography: 17px / 400 / 42px / unresolved computed stack
    states: 'rest on three links (capture 23-25); the five links after them in the same row (capture 26-30) record #434343, 16px / 400 / 42px, tracking -2px and 0px 24px padding; no state frame'
    use: Public-home quick menu link (a.q1) at home::[data-omd-capture="23"], tracking -1px
  cert-shortcut-card:
    type: card
    backgroundColor: rgba(255, 255, 255, 0.6)
    border: '3px #ffffff'
    rounded: 0px
    padding: 9px 17px
    size: 134px x 110px
    shadow: rgba(0, 0, 0, 0.05) 0px 0px 5px 0px
    states: one link captured at rest; no state frame
    use: 'Public-home certificate shortcut link (a.go_cert) at home::[data-omd-capture="22"], over the hero banner; its #5a5a5a 14px / 400 / 21px equals the page body text, so no label style is claimed'
  service-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #dddddd'
    rounded: 0px
    padding: 24px 28px
    size: 310px x 180px
    states: three cards captured at rest (links capture 39-41); no state frame
    use: 'Public-home service card: a bordered li holding a full-card link (a at home::[data-omd-capture="39"], padding 24px 28px); the link records the page body text (#5a5a5a 14px / 400 / 21px), so no label style is claimed'
  section-more-link:
    type: button
    backgroundColor: transparent
    textColor: '#929292'
    rounded: 0px
    padding: 0px 14px 0px 0px
    height: 18px
    typography: 12px / 400 / 18px / unresolved computed stack
    states: rest on three links (capture 34, 38, 53); no state frame
    use: Section more link (a.sub) beside public-home section headings at home::[data-omd-capture="34"]
  quick-service-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    size: 78px x 74px
    typography: 16px / 400 / 24px / unresolved computed stack
    states: rest on eight links (capture 45-52); no state frame
    use: Public-home icon service link (a.ico1 to a.ico8) at home::[data-omd-capture="45"]; the icon is not among the captured properties
  app-service-link:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    size: 118px x 92px
    typography: 13px / 700 / 19.5px / unresolved computed stack
    states: rest on four links (capture 60-63); no state frame
    use: Public-home icon link group under a 20px / 700 heading at home::[data-omd-capture="60"]; the icon is not among the captured properties
  ui-toggle-button:
    type: toggle
    backgroundColor: '#ffffff'
    border: '1px #929292'
    rounded: 0px
    padding: 0px 0px 0px 12px
    size: 14px x 14px
    states: one toggle captured at rest; no aria-checked is recorded; no state frame
    use: Public-home 14px square toggle (button.ui-toggle) at home::[data-omd-capture="59"]; its four-character label is pushed outside the 14px box by 12px left padding, so no label style is claimed
  footer-select-link:
    type: button
    backgroundColor: transparent
    textColor: '#5a5a5a'
    border: '1px #bbbbbb'
    rounded: 0px
    padding: 8px 60px 7px 10px
    height: 37px
    typography: 13px / 400 / 17px / unresolved computed stack
    states: 'rest on three footer select links (capture 78, 79, 81); capture 78 records border 1px #666666 and capture 79 padding 8px 30px 7px 10px; no state frame'
    use: Footer select link (a.tit) at home::[data-omd-capture="81"], 172 x 37
  top-banner-link:
    type: button
    backgroundColor: transparent
    textColor: '#ffcc00'
    rounded: 0px
    padding: 0px
    typography: 14px / 400 / 21px / unresolved computed stack
    states: one link captured at rest; no state frame
    use: 'Public-home top notice link at home::[data-omd-capture="0"], 165 x 21, tracking -0.5px; the notice also holds a checkbox (capture 1) and a #ffffff 12px close link (capture 2); the notice background is not among the captured elements'
  online-section-tab:
    type: tab
    backgroundColor: '#f1efe9'
    textColor: '#777777'
    border: '1px #c9c9c2 on the top and bottom edges'
    rounded: 0px
    padding: 0px 10px
    height: 55px
    typography: 14px / 400 / 17.5px / operating-system stack
    selected: 'bg #ffffff, fg #000000, 14px / 700, border 2px #ffa736 on the top edge and 1px #c9c9c2 on the right edge'
    states: 'rest on two tabs (capture 16, 17; capture 16 also has a 1px #c9c9c2 right edge); the tab whose li has class on (capture 15) differs from them and is recorded as selected; no aria-selected is recorded; no state frame'
    use: Online-banking section tab link (a.tabLink) at surface-2::[data-omd-capture="16"], 467 x 55, tracking -1px
  online-product-row:
    type: listItem
    border: '1px #e5e5e5 on the top edge of the following li'
    padding: 19px 5px 16px
    height: 124px
    states: two rows captured at rest; no state frame
    use: 'Online-banking product list row: a full-width link (a at surface-2::[data-omd-capture="18"], padding 19px 5px 16px) in li.pro3; the next li records a 1px #e5e5e5 top border; the link records the page text colour #333333 with the 22.4px line height of its li, so no label style is claimed'
  footer-link:
    type: listItem
    textColor: '#333333'
    rounded: 0px
    padding: 0px 8px 0px 9px
    height: 24px
    typography: 13px / 400 / 24px / unresolved computed stack
    states: 'rest on thirteen of the fourteen footer links (capture 64-77 except 67); capture 67 records #0c4ad1 and is recorded as home-inline-list-item; no state frame'
    use: Public-home footer link at home::[data-omd-capture="64"], tracking -1px
---

# KB국민은행

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KB국민은행; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kb-kookmin/DESIGN.md
