---
name: NHN
colors:
  primary: '#212126'
  foreground: '#36363d'
  muted: '#57575b'
  subtle: '#62626a'
  hint: '#aaaaae'
  surface: '#f8f8f8'
  canvas: '#ffffff'
  hairline: '#e5e7eb'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed corporate body/list text
  nav:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.75
    use: Observed primary navigation action
  label:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.57
    use: Observed secondary action and label
  title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed Korean heading
rounded:
  none: 0px
  pill: 50px
spacing:
  xs: 4
  sm: 7
  md: 8
  base: 10
  lg: 22
  xl: 32
  xxl: 80
components:
  previous-control:
    type: button
    rounded: 0px
    size: 26px x 32px
    states: 'captured disabled on the services surface (captures 37, 40, 44: the carousels sat on their first slide). Its dumped properties equal the enabled next control (captures 38, 41, 45); the class list names opacity-40, but opacity is outside the dump, so no disabled value is declared. Corrected 2026-09-30: the July entry took its values from the disabled element, gave it the inherited body text (#212126, 16px / 400) as a label although the control is icon-only, and stated opacity 0.4 from the class name'
    use: Carousel previous control (button.prevNav) on the services surface; geometry from the enabled next control at surface-2::[data-omd-capture="38"]
  gnb-submenu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#57575b'
    rounded: 0px
    padding: 0px
    height: 22px
    typography: 14px / 500 / Pretendard Variable
    selected: font 14px / 700, tracking normal
    hover: font 14px / 700, tracking normal
    pressed: font 14px / 700, tracking normal
    states: rest, hover and pressed sampled on 52 header sub-menu links across the three surfaces (104 frames). Every frame changes only the weight (500 to 700) and the tracking (-0.14px to normal); the colour and every other dumped property stay at rest. The current sub-page link computes the same 700 / normal at rest on services (capture 10) and IR (capture 17), so the value is settled. Focus was not sampled
    use: Header sub-menu link (a.text-body11-m inside li.py-7) at home::[data-omd-capture="2"]; 48-90 px wide, line height 22px, rest tracking -0.14px
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#36363d'
    rounded: 0px
    padding: 0px
    height: 28px
    typography: 16px / 500 / Pretendard Variable
    selected: font 16px / 700
    states: rest captured on all three surfaces; the current section's link computes 700 on services (capture 6) and on IR (capture 14), the same pairing on both routes. No state frame
    use: Header main navigation link (a.text-body10-m inside li.mainLink, which carries the colour and 80px right padding) at home::[data-omd-capture="1"]; line height 28px
  category-tab-pill:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#62626a'
    rounded: 40px
    padding: 0px 32px
    height: 48px
    typography: 16px / 500 / Pretendard Variable
    selected: 'bg #212126, fg #ffffff, 16px / 700'
    states: 'unselected pills captured on services (four) and IR (five); the pill for the current tab computes bg #212126, fg #ffffff and 700 on both routes (services capture 35, IR capture 34) and adds cursor-default to its class list. No aria-selected is recorded; no state frame. The class list names a border, but its computed width is 0px'
    use: Services and IR category tab pill (a.rounded-40) at surface-2::[data-omd-capture="33"]; 92-124 px wide, line height 28px
  services-pill:
    type: button
    backgroundColor: '#f8f8f8'
    textColor: '#62626a'
    rounded: 50px
    padding: 4px 8px 4px 14px
    height: 32px
    typography: 14px / 500 / Pretendard Variable
    states: four captured at rest on services (button capture 43; links 39, 42, 46); no state frame
    use: Services tag pill at surface-2::[data-omd-capture="43"]; 90-109 px wide, line height 22px, tracking -0.14px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  ir-subtab-link:
    type: tab
    backgroundColor: transparent
    textColor: '#aaaaae'
    rounded: 100px
    padding: 11.008px 0px 11.008px 32px
    height: 50px
    typography: 16px / 500 / Pretendard Variable
    selected: 'fg #212126, font 16px / 700 (label)'
    states: 'two captured on IR; one (capture 38) computes #212126 with a 700 label, the other #aaaaae with 500. No aria-selected is recorded, so the pairing rests on that difference on a route carrying a subTab parameter. The hover colours in the class lists are declarations; no state frame'
    use: IR financial sub-tab link (a, 240 px wide) at surface-3::[data-omd-capture="39"]; the font is its li label (line height 28px)
  feature-card:
    type: card
    backgroundColor: '#f8f8f8'
    textColor: '#ffffff'
    rounded: 24px
    size: 612px x 702px
    typography: 32px / 800 / Main Pretendard Variable
    states: one card captured at rest on home; no state frame
    use: 'Home feature card at home::[data-omd-capture="33"]; text colour and font are the child h2 (line height 48px); the root''s #212126 / 16px / 400 are the inherited body text'
  news-list-item:
    type: card
    backgroundColor: transparent
    textColor: '#36363d'
    padding: 0px 22px 0px 0px
    size: 508px x 126px
    typography: 20px / 700 / Main Pretendard Variable
    states: nine captured at rest on home (captures 35-43); no state frame
    use: 'Home news list item at home::[data-omd-capture="35"]; text colour and font are the child h3 (line height 30px, clamped to two lines); the root''s #212126 / 16px / 400 are the inherited body text'
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#212126'
    rounded: 0px
    padding: 0px
    height: 28px
    typography: 16px / 500 / Pretendard Variable
    states: captured on all three surfaces; the nine-character item (capture 47, 114 px wide) computes 700. No state frame
    use: Footer link and link-styled button (text-grayscale-1 min-w-[56px] text-body10-l) at home::[data-omd-capture="45"]; minimum width 56px, line height 28px
  footer-social-button:
    type: button
    backgroundColor: '#f8f8f8'
    border: '1px #f8f8f8'
    rounded: 100px
    padding: 10px
    size: 42px x 42px
    states: four per surface, captured at rest on all three surfaces; icon only; no state frame
    use: Footer social link (a with border-grayscale-12 bg-grayscale-12) at home::[data-omd-capture="50"]
fonts:
  roles:
    ui: Pretendard Variable
    display-kr: Main Pretendard Variable
---

# NHN

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NHN; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/nhn/DESIGN.md
