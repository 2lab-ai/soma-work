---
name: Inflearn
colors:
  canvas: '#ffffff'
  ink: '#212529'
  text: '#495057'
  neutral: '#f8f9fa'
  subtle: '#f1f3f5'
  hairline: '#dee2e6'
  primary: '#00c471'
  primary-hover: '#00a760'
  info-surface: '#e7f5ff'
  info: '#228be6'
  cyan-tag-surface: '#e3fafc'
  cyan-tag: '#1098ad'
typography:
  product-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated product-home and course-catalog text/card sample
  product-control:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1
    use: Product GNB and control sample
  course-badge:
    fontSize: 11px
    fontWeight: 700
    lineHeight: 1.64
    use: Course badge wrapper on product home and catalog
rounded:
  badge: 4px
  input: 8px
  pill: 32px
  full: 999px
spacing:
  xs: 4
  sm: 8
  md: 10
  lg: 16
components:
  product-search-submit:
    type: button
    backgroundColor: '#00c471'
    textColor: '#ffffff'
    rounded: 999px
    hover: 'bg #00a760'
    pressed: 'bg #00a760'
    focus: '#212529'
    disabled: '#f1f3f5'
    states: 'rest on the GNB search submit on both routes (capture 8); hover and pressed sampled on both, all four frames recording bg #00a760; the focus and disabled values come from a 2026-09-16 live CSS inspection (claim method live-css-inspect) that does not name the property, and the bundle holds no focus or disabled frame on this element, so it cannot confirm them'
    use: 'Product GNB search submit; home::[data-omd-capture=8]; icon-only (no text node), so fg is the computed colour its glyph can inherit. Corrected 2026-09-30: the July font leaf (16px / 400 Pretendard) was the inherited page type on an element without text and was removed'
    height: 42px
    padding: 0px
  product-nav-action:
    type: button
    backgroundColor: '#f8f9fa'
    textColor: '#495057'
    rounded: 32px
    padding: 0px 22px
    typography: 16px / 600 Pretendard
    hover: bg rgba(241, 243, 245, 0.65)
    pressed: bg rgba(241, 243, 245, 0.65)
    disabled: '#f1f3f5'
    states: rest on the GNB button on both routes (capture 12); hover and pressed sampled on it and on the two icon buttons beside it (capture 10, 11), all twelve frames recording bg rgba(241, 243, 245, 0.65); the disabled value comes from the 2026-09-16 live CSS inspection, and the bundle holds no disabled frame on this element; focus not declared
    use: Product GNB navigation action; home::[data-omd-capture=12]
  product-course-card:
    type: card
    rounded: 8px
    states: default only; no card interaction state captured
    use: 'Product course article shell; home::article (article.mantine-Card-root, 262 x 307 on home). Corrected 2026-09-30: the July font leaf (16px / 400 Pretendard) was the inherited page type on a container and was removed'
  product-content-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#212529'
    rounded: 9999px
    padding: 10px 16px
    typography: 14px / 400 / 14px system sans-serif
    selected: 'bg #25262b, fg #ffffff, 14px / 700'
    hover: 'bg #f8f9fa'
    pressed: 'bg #f8f9fa'
    states: 'rest on the tabs with aria-selected "false" (capture 20-24); the tab with aria-selected "true" (capture 19, interaction capture tab-3-0) is recorded as selected; hover and pressed sampled on four rest tabs (capture 20-23), all eight frames recording bg #f8f9fa; focus not declared. Corrected 2026-09-30: the July record stored the selected fill as the rest value'
    use: Product-home content tab (button, role tab) at home::[data-omd-capture=20]
  product-dialog-overlay:
    type: dialog
    backgroundColor: rgba(0,0,0,0.6)
    states: dialog-open observed
    use: 'Product dialog backdrop; home::[data-omd-interaction-capture=dialog-2-8], 1440 x 900 behind the panel listed as product-modal. Corrected 2026-09-30: the July font leaf (16px / 400 Pretendard) was the inherited page type on an element with no text and was removed'
  gnb-service-link:
    type: tab
    backgroundColor: transparent
    rounded: 0px
    padding: 6px 10px
    height: 44px
    hover: 'bg #f8f9fa, radius 50px'
    pressed: 'bg #f8f9fa, radius 50px'
    states: 'rest on five links on both routes (capture 1-5); hover and pressed sampled on all ten, all twenty frames recording bg #f8f9fa with a 50px radius; focus not declared'
    use: 'GNB service link (a, Mantine Anchor) at home::[data-omd-capture="1"], 84 x 44; the link element''s own colour is #00a760 and its type equals the page text, and its label sits in a child the capture did not sample, so no label style is claimed'
  gnb-menu-trigger:
    type: button
    backgroundColor: transparent
    border: 1px transparent
    rounded: 32px
    size: 61px x 42px
    hover: 'bg #f8f9fa'
    pressed: 'bg #f8f9fa'
    states: 'rest on both routes (capture 6); hover and pressed sampled on both, all four frames recording bg #f8f9fa; activating it opened the menu listed as gnb-menu (menu-open, expanded); focus not declared'
    use: GNB menu button (aria-haspopup menu) at home::[data-omd-capture="6"]; icon-only, so no label colour is claimed
  gnb-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#495057'
    border: 1px transparent
    rounded: 32px
    padding: 0px 12px
    height: 42px
    typography: 16px / 600 / 16px Pretendard
    hover: 'bg #f8f9fa'
    pressed: 'bg #f8f9fa'
    states: 'rest on both routes (capture 9); hover and pressed sampled on both, all four frames recording bg #f8f9fa; focus not declared'
    use: GNB text button (a, Mantine Button) at home::[data-omd-capture="9"], 81 x 42
  gnb-icon-trigger:
    type: button
    backgroundColor: '#f8f9fa'
    border: 1px transparent
    rounded: 32px
    size: 42px x 42px
    hover: bg rgba(241, 243, 245, 0.65)
    pressed: bg rgba(241, 243, 245, 0.65)
    states: rest on two icon buttons per route (capture 10, 11); hover and pressed sampled on all four, all eight frames recording bg rgba(241, 243, 245, 0.65), the value the GNB navigation action takes; each opened a popover or modal (dialog-open); focus not declared
    use: GNB icon button (aria-haspopup dialog) at home::[data-omd-capture="10"]; icon-only, so no label colour is claimed
  gnb-search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 8px
    size: 377px x 36px
    typography: 16px / 400 / 34px Pretendard
    states: default captured on both routes; its pressed and focus frames change only the colour of a 0px border, and the values drift between routes, so no state is declared
    use: GNB search input at home::[data-omd-capture="7"]; border width 0px, so no field border is claimed
  gnb-menu:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #e9ecef'
    rounded: 8px
    padding: 4px
    size: 110px x 256px
    shadow: rgba(0, 0, 0, 0.05) 0px 1px 3px 0px, rgba(0, 0, 0, 0.05) 0px 20px 25px -5px, rgba(0, 0, 0, 0.04) 0px 10px 10px -5px
    states: captured open after the GNB menu button was activated on both routes (menu-open, expanded)
    use: 'GNB menu dropdown (div, role menu) at home::[data-omd-interaction-capture="menu-0-0"]; its #212529 16px / 400 is the inherited page text on a container, so no label style is claimed'
  gnb-menu-item:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 8px
    padding: 10px 12px
    height: 41px
    typography: 14px / 400 / 16.1px Pretendard
    states: six items captured in the open menu; no state frame
    use: GNB menu item (button, role menuitem) at home::[data-omd-interaction-capture="menu-0-1"], 100 x 41
  gnb-popover:
    type: dialog
    backgroundColor: '#ffffff'
    border: '1px #e9ecef'
    rounded: 16px
    padding: 12px 10px
    size: 253px x 248px
    shadow: rgba(0, 0, 0, 0.05) 0px 1px 3px 0px, rgba(0, 0, 0, 0.05) 0px 10px 15px -5px, rgba(0, 0, 0, 0.04) 0px 7px 7px -5px
    states: captured open (dialog-open) after a GNB icon button was activated
    use: GNB popover (div, role dialog) at home::[data-omd-interaction-capture="dialog-1-0"]
  product-modal:
    type: dialog
    backgroundColor: '#ffffff'
    rounded: 16px
    size: 320px x 263px
    shadow: rgba(0, 0, 0, 0.05) 0px 1px 3px 0px, rgba(0, 0, 0, 0.05) 0px 36px 28px -7px, rgba(0, 0, 0, 0.04) 0px 17px 17px -7px
    states: 'captured open (dialog-open) over the overlay listed as product-dialog-overlay; it holds a close button (dialog-2-2, 31 x 31, 8px radius) and a radio group whose first radio records a #00c471 fill and border against #ffffff with 1px #ced4da on the others; no aria-checked is recorded, so no checked state is declared'
    use: 'Modal panel (section, role dialog) at home::[data-omd-interaction-capture="dialog-2-0"]; its #495057 14px / 400 / 21px is content colour set on the panel, not a label style'
  hero-carousel-icon-button:
    type: button
    backgroundColor: rgba(248, 249, 250, 0.2)
    border: 1px transparent
    rounded: 32px
    size: 30px x 30px
    hover: bg rgba(248, 249, 250, 0.4)
    pressed: bg rgba(248, 249, 250, 0.4)
    states: rest on two buttons (capture 15, 16); hover and pressed sampled on both, all four frames recording the same value; focus not declared
    use: Icon button over the home hero banner at home::[data-omd-capture="15"]; icon-only, so no label colour is claimed
  home-carousel-arrow:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212529'
    border: '1px #ced4da'
    rounded: 32px
    size: 30px x 30px
    hover: 'bg #f8f9fa, fg #000000'
    pressed: 'bg #f8f9fa, fg #000000'
    states: 'hover and pressed frames agree exactly and both colours are rest colours elsewhere on the page; its sibling (capture 17) is disabled and records bg #f1f3f5, fg #adb5bd, border 1px #dee2e6; focus not declared'
    use: Home carousel arrow (button) at home::[data-omd-capture="18"]; icon-only, so fg is the computed colour its glyph can inherit
  home-article-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px #e9ecef'
    rounded: 8px
    size: 246px x 139px
    states: default on fifteen cards (capture 46-60); no state frame
    use: Home link card (a, role article) at home::[data-omd-capture="46"]; a container whose own colour is the browser default link blue, so no label style is claimed
  course-tag-badge:
    type: badge
    backgroundColor: '#e7f5ff'
    textColor: '#228be6'
    border: 1px transparent
    rounded: 4px
    padding: 0px 4px
    height: 20px
    typography: 11px / 700 / 18px Pretendard, letter-spacing 0.25px
    states: 'default on the blue pair (ten on home); the same geometry and type carry #e3fafc / #1098ad, #00a760 / #ffffff and, on the catalog, #228be6 / #ffffff; no state frame'
    use: Course badge (div.mantine-Badge-root) on home and catalog, 51 x 20; bare selector home::div
  course-filter-chip:
    type: button
    backgroundColor: rgba(73, 80, 87, 0.1)
    textColor: '#495057'
    border: 1px transparent
    rounded: 32px
    padding: 0px 18px
    height: 36px
    typography: 14px / 600 / 14px system sans-serif
    hover: bg rgba(73, 80, 87, 0.12)
    pressed: bg rgba(73, 80, 87, 0.12)
    states: rest on nine chips (capture 14-22); hover and pressed sampled on all nine, all eighteen frames recording the same value; focus not declared
    use: Course-catalog filter chip (button) at surface-2::[data-omd-capture="14"], 106 x 36
  course-pagination:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px #ced4da'
    rounded: 8px
    padding: 9.5px
    size: 38px x 38px
    typography: 18px / 400 / 18px system sans-serif
    states: 'rest on five page buttons (capture 71-75); capture 70 records bg #00c471, fg #ffffff and border 1px #00c471, but only generated classes separate it, so no selected state is declared; the previous-page button (capture 69) is disabled; no state frame'
    use: Course-catalog pagination button at surface-2::[data-omd-capture="71"]
fonts:
  roles:
    ui: Pretendard
---

# Inflearn

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Inflearn; reproduced for educational reference. Full prose: https://oh-my-design.kr/inflearn/design.md
