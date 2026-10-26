---
name: JANDI
colors:
  primary: '#00c473'
  canvas: '#ffffff'
  on-dark: '#ffffff'
  ink: '#000000'
  ink-muted: '#333333'
  muted: '#a2a2a2'
  action-ink: '#041911'
typography:
  hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.43
    use: Public landing headline
  section:
    fontSize: 42px
    fontWeight: 700
    lineHeight: 1.43
    use: Public landing feature heading
  nav-action:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Public global navigation action
rounded:
  action: 6px
  floating-nav: 10px
  security-card: 16px
spacing:
  nav-action-y: 7
  nav-action-x: 14
  landing-action-y: 12
  landing-action-x: 30
components:
  security-environment-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 40px 32px 54px
    shadow: rgba(0, 18, 47, 0.08) 0px 14px 24px 0px
    use: 'Static security environment card; surface-5::li.Security_securityEnvironmentList__3CRP0; its text sits in children (h3 #333333 24px / 700 / 34px, p #333333 16px / 400 / 24px)'
  ai-environment-card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 16px
    padding: 40px 32px 54px
    shadow: rgba(0, 18, 47, 0.16) 0px 14px 24px 0px
    use: 'Static AI environment card; surface-6::li.JandiAi_aiEnvironmentList__2ng2t; its text sits in children (strong #333333 40px / 700 / 42px, h3 24px / 700 / 34px, p 16px / 400 / 24px)'
  header-primary-action:
    type: button
    backgroundColor: '#00c473'
    textColor: '#ffffff'
    border: '1px #00c473'
    rounded: 6px
    padding: 7px 14px
    height: 36px
    typography: 14px / 500 / 20px Noto Sans
    states: rest on all six capture records (capture 10 on each); the bundle holds no state frame for any JANDI element
    use: Global navigation primary action (a) at home::[data-omd-capture="10"], 69 x 36; the same values repeat on surface-2 through surface-6
    pressed: 'bg #00b46a, border #00b46a (:hover + :active)'
  header-outline-action:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px #dddddd'
    rounded: 6px
    padding: 7px 14px
    height: 36px
    typography: 14px / 500 / 20px Noto Sans
    states: rest on all six capture records (capture 9 on each); no state frame
    use: Global navigation outline action (a) beside the primary action at home::[data-omd-capture="9"], 82 x 36
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 8px 14px
    height: 36px
    typography: 14px / 500 / 20px Noto Sans
    states: rest on eight menu links (capture 1-8) on all six capture records; no link records a different value and no state frame exists
    use: 'Global navigation menu link (a) at home::[data-omd-capture="1"]; the label is the a itself, while its li records the inherited #000000 14px / 400 text and is not read as the label'
  landing-white-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#041911'
    rounded: 6px
    padding: 12px 30px
    height: 44px
    typography: 15px / 500 / 20px Noto Sans
    states: rest on two links on the landing record (capture 19, 20; surface-2 repeats them); no state frame
    use: White landing action (a) at home::[data-omd-capture="19"], 115 x 44
  feature-floating-nav-button:
    type: button
    backgroundColor: transparent
    rounded: 10px
    padding: 12px
    size: 105px x 105px
    states: rest on five buttons on the collaboration page (capture 11-15) and four on the member page (capture 11-14); no state frame
    use: 'Floating feature-navigation item (div, role button) at surface-3::[data-omd-capture="11"], set in a white bar (div.floatingNavButtonContainer: bg #ffffff, padding 0px 120px; inner gap 8px); its #000000 16px / 400 / 16px equals the page body text, so no label style is claimed'
  security-accordion-button:
    type: button
    backgroundColor: transparent
    textColor: '#a2a2a2'
    rounded: 0px
    padding: 16px 0px
    height: 62px
    typography: 20px / 700 / 30px Noto Sans
    states: 'rest on eight buttons in two groups (capture 12-15, 17-20); the first button of each group (capture 11, 16) records fg #00c473, 32px / 700 / 46px and padding 0px 0px 16px and is the only one followed by a captured description paragraph; the bundle records no aria-expanded or aria-selected on these buttons, so that variant is described, not declared as a state; no state frame'
    use: Security-page accordion button (button.Security_accordionButton__2zHEj) at surface-5::[data-omd-capture="12"], 460 x 62
  ai-faq-question-button:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 24px 0px
    height: 76px
    typography: 20px / 400 / 28px Noto Sans
    states: rest on five question buttons (capture 11-15); capture 11 carries an extra class but records the same values, so no variant is declared; no state frame
    use: JANDI AI page FAQ question button at surface-6::[data-omd-capture="12"], each in a 1200 x 76 li
  bottom-banner-pill-link:
    type: button
    textColor: '#041911'
    rounded: 50px
    padding: 12px 30px
    height: 44px
    typography: 15px / 500 / 20px Noto Sans
    states: rest on two links on the security page (capture 25, 26) and two on the AI page (capture 16, 17); no state frame
    use: Bottom-banner pill link (a.JndLink_green__3tVcD) at surface-5::[data-omd-capture="25"], 115 x 44; its background-color computes transparent and background-image is not among the captured properties, so no fill is claimed
  footer-sitemap-link:
    type: listItem
    textColor: '#ffffff'
    padding: 8px 0px
    height: 36px
    typography: 13px / 700 / 20px Noto Sans
    states: rest on 21 links (capture 21-41); no state frame
    use: 'Footer sitemap link: the label a at home::[data-omd-capture="22"] sits in a 120 x 36 li with 8px 0px padding; the footer background is not among the captured elements'
  footer-info-toggle:
    type: button
    backgroundColor: transparent
    textColor: '#a2a2a2'
    rounded: 0px
    padding: 5px 0px
    height: 36px
    typography: 14px / 400 / 26px Noto Sans
    states: rest on one button per capture record (home and surface-2 capture 43, surface-3 40, surface-4 39, surface-5 49, surface-6 40); no state frame
    use: 'Footer text button at home::[data-omd-capture="43"], 83 x 36, beside the #a2a2a2 13px / 400 / 20px company-information lines'
  ai-partner-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 16px
    padding: 8px 16px 24px
    size: 382px x 369px
    typography: 16px / 400 / 30px Noto Sans
    states: three cards captured at rest; no state frame
    use: 'JANDI AI partner card (li.JandiAi_aiPartnerCardItem__15AOx, 16px radius, 382 x 369): a 382 x 210 image block over a content block (div.JandiAi_aiPartnerCardContents__3H6Wk: bg #ffffff, padding 8px 16px 24px) holding a logo and a #333333 16px / 400 / 30px description (p)'
fonts:
  roles:
    ui: Noto Sans
---

# JANDI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to JANDI; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/jandi/DESIGN.md
