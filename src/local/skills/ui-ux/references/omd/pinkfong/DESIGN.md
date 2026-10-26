---
name: The Pinkfong Company
colors:
  primary: '#ff66af'
  canvas: '#ffffff'
  foreground: '#000000'
  muted: '#5a5a5a'
typography:
  corporate-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5715
    use: Observed corporate body text on the supplied public routes.
  corporate-heading:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.5715
    use: Observed corporate-company h1 scale; its computed family is the system stack, not a Pinkfong font token.
  brand-display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    use: One corporate-business h1 uses loaded BabyShark; official release calls the distributed family Pinkfong Baby Shark Font.
rounded:
  none: 0px
  compact: 8px
  pill: 32px
  emphasis: 40px
spacing:
  xs: 8
  control: 20
  action: 32
components:
  corporate-primary-action:
    type: button
    backgroundColor: '#ff66af'
    textColor: '#ffffff'
    rounded: 32px
    padding: 32px 15px
    typography: 24px / 400 / system stack
    states: Default captured; this element has no pointer-state frame.
    use: corporate-home `home::[data-omd-capture="26"]`; one public corporate CTA, 64px rendered height.
    height: 64px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: 'outline #ffe0ec solid 3px on :focus-visible'
  family-site-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#8c8c8c'
    rounded: 32px
    padding: 4px 20px
    typography: 14px / 400 / system stack
    states: Default captured; this element has no pointer-state frame.
    use: '`home::[data-omd-capture="31"]`, repeated across the three corporate routes; 35px rendered height.'
  business-outline-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#08c7ff'
    rounded: 32px
    padding: 30px 15px
    typography: 18px / 400 / system stack
    states: 'Default captured. The hover, pressed and focus frames on `surface-2::[data-omd-capture="23"]` move bg #ffffff to #fffffe or #fffffc and fg #08c7ff to #09c7ff, #0bc8ff or #0ec8ff, a transition caught in progress, so no state value is declared; focus is never declared from this collector.'
    use: corporate-company `surface-2::[data-omd-capture="23"]`; one public company-page action, 60px rendered height.
  mobile-menu-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#000000'
    padding: 30px
    typography: 14px / 400 / system stack
    use: '`home::div.DefaultMenu_mobile-menu-modal__SEaJA`; hidden mobile-menu dialog structure captured on all three corporate routes.'
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(0, 0, 0, 0.88)
    rounded: 0px
    padding: 0px 16px
    height: 64px
    typography: 14px / 400 / 64px system stack
    selected: 'fg #ff66af'
    states: 'rest on every header menu link; the current-page item (li.ant-menu-item-selected) computes #ff66af on the company and business pages; no pointer-state frame'
    use: 'Header menu link: the anchor at home::[data-omd-capture="5"] inside the antd menu item li at "4"; padding and height belong to that li'
  header-submenu-trigger:
    type: button
    backgroundColor: transparent
    textColor: rgba(0, 0, 0, 0.88)
    rounded: 8px
    padding: 0px
    size: 48px x 64px
    typography: 14px / 400 / 64px system stack
    states: default captured on all three pages (capture 14); it declares aria-haspopup, but the collector opened no submenu and recorded no pointer-state frame for it
    use: Header submenu title (div.ant-menu-submenu-title) at home::[data-omd-capture="14"]
  locale-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#dddddd'
    rounded: 0px
    padding: 0px
    size: 44px x 15px
    typography: 13.3333px / 400 / Arial
    selected: 'fg #2e2e2e'
    states: inactive and active-locale (class LocaleSelector_active) buttons captured as pairs on all three pages (capture 1/2 and 21/22); no pointer-state frame
    use: 'Header locale switch at home::[data-omd-capture="2"]; the active locale at "1" computes #2e2e2e. The 13.3333px Arial is the browser default button font as computed, not a brand face'
  section-more-link:
    type: button
    backgroundColor: transparent
    textColor: '#a0a0a0'
    rounded: 0px
    padding: 0px
    size: 121px x 25px
    typography: 16px / 400 / 25.144px system stack
    states: 'default captured on three carousel copies (capture 23-25); the hover and pressed frames of "23" record #c08ca5 and its focus frame #be8ba6, a colour caught mid-transition that matches no rest colour, so no hover or pressed value is declared'
    use: Home business-section more link with a right-arrow icon (a.BusinessSection_more) at home::[data-omd-capture="23"]
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#5a5a5a'
    rounded: 0px
    padding: 0px
    height: 17px
    typography: 14px / 400 / 22.001px system stack
    states: default captured on five footer links on each of the three pages (home 32-36, company 34-38); no pointer-state frame
    use: Footer link row at home::[data-omd-capture="32"]
  history-collapse-header:
    type: button
    backgroundColor: transparent
    textColor: rgba(0, 0, 0, 0.88)
    rounded: 8px 8px 0px 0px
    padding: 12px 16px
    height: 55px
    typography: 14px / 400 / 22px system stack
    states: default captured on six collapsed headers (capture 24-29); the collector expanded none and recorded no pointer-state frame
    use: Company-page history accordion header (div.ant-collapse-header, role=button) at surface-2::[data-omd-capture="24"]; the first header rounds 8px 8px 0px 0px, the middle four 0px, the last 0px 0px 8px 8px
  business-primary-action:
    type: button
    backgroundColor: '#ff66af'
    textColor: '#ffffff'
    rounded: 40px
    padding: 40px 15px
    height: 82px
    typography: 19px / 400 / system stack
    shadow: rgba(255, 5, 88, 0.06) 0px 2px 0px 0px
    states: default captured on two buttons (capture 23 and 40, 344 and 327 wide); the business page has no state frame
    use: Business-page pink action (antd round primary button) at surface-3::[data-omd-capture="23"]; its label is the inner link at "24" (#ffffff, 19px / 400, 0px 50px padding); its 1px border computes rgba(0, 0, 0, 0)
  business-overlay-chip:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.5)
    textColor: rgba(255, 255, 255, 0.4)
    rounded: 24px
    padding: 0px 7px
    height: 24px
    typography: 14px / 400 / system stack
    shadow: rgba(255, 5, 88, 0.06) 0px 2px 0px 0px
    states: default captured on fifteen chips (capture 25-39; "25" is 26px high); no pointer-state frame
    use: Business-page translucent round chip (restyled antd round primary button) at surface-3::[data-omd-capture="26"]; what the chips switch or label is not in the dump
fonts:
  roles:
    corporate-ui: Spoqa Han Sans Neo
    brand-display: Pinkfong Baby Shark Font
---

# The Pinkfong Company

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to The Pinkfong Company; reproduced for educational reference. Full prose: https://oh-my-design.kr/pinkfong/design.md
