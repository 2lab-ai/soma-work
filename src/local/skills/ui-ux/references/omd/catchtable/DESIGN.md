---
name: CatchTable
colors:
  canvas: '#ffffff'
  foreground: '#000000'
  title: '#222222'
  muted: '#666666'
  search-surface: '#f5f5f5'
  control-border: '#e4e4e4'
  brand-orange: '#ff3d00'
  on-brand: '#ffffff'
typography:
  consumer-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Repeated consumer-home body and button sample
  consumer-title:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Consumer-home section-title sample
  search-control:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.5
    use: Consumer-home search input
  career-display:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.35
    use: Careers-service marketing heading
rounded:
  square: 0px
  discovery-tile: 6px
  control: 8px
  search: 40px
  career-action: 15px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 20
components:
  consumer-search:
    type: input
    backgroundColor: '#f5f5f5'
    textColor: '#000000'
    rounded: 40px
    padding: 0px 15px 0px 32px
    typography: 15px / 500 Pretendard Std Variable
    states: default only; no interaction state captured
    use: Consumer-home search input, selector home::[data-omd-capture=0]
  consumer-filter-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #e4e4e4'
    rounded: 8px
    height: 32px
    typography: 16px / 400 Pretendard Std Variable
    states: default only; no interaction state captured
    use: Consumer-home compact filter/control, selector home::[data-omd-capture=1]
  consumer-discovery-tile:
    type: button
    rounded: 6px
    padding: 8px 12px
    typography: 16px / 400 Pretendard Std Variable
    states: default only; no interaction state captured
    use: Consumer-home image-led discovery tile, selector home::[data-omd-capture=17]
  merchant-cta:
    type: button
    backgroundColor: '#002d4e'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    typography: 16px / 700 Pretendard
    shadow: rgba(202, 202, 202, 0.4) 0px 0px 4px 2px
    states: default only; no interaction state captured
    use: Merchant-marketing CTA link, selector surface-2::[data-omd-capture=20]
  careers-orange-action:
    type: button
    backgroundColor: '#ff3d00'
    textColor: '#ffffff'
    rounded: 15px
    padding: 10.5px 24px
    typography: 16px / 400 Pretendard
    states: default only; no interaction state captured
    use: Careers-service marketing action, selector surface-3::[data-omd-capture=14]
  merchant-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#37352f'
    rounded: 0px
    padding: 0px
    height: 56px
    typography: 16px / 700 / 24px Pretendard
    hover: 'fg #002d4e'
    pressed: 'fg #002d4e'
    states: 'rest on two links (capture 1 and 2); hover and pressed sampled on both, all four frames recording #002d4e, the merchant CTA fill; focus not declared'
    use: Merchant-site global navigation link (a.css-rx11nm) at surface-2::[data-omd-capture="1"], 60 x 56 (capture 2 is 69 x 56); the colour of its 0px border follows the text and is not a border
  merchant-submit-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#002d4e'
    border: '2px #002d4e'
    rounded: 8px
    padding: 0px
    height: 53px
    typography: 16px / 700 / 18.4px Pretendard
    states: 'rest declared only. The hover and pressed frames agree (text and border #0d3857, fill #f2f4f6), but each channel sits about 5% of the way from its rest colour toward the element''s other rest colour (fill toward #002d4e, text toward #ffffff): a transition frame, so neither is declared; focus not declared'
    use: Merchant inquiry-form submit button (button.btn-submit, type=submit) at surface-2::[data-omd-capture="14"], 260 x 53
  merchant-form-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    padding: 16px
    size: 414px x 77px
    typography: 16px / 400 / 18.4px Pretendard
    states: default captured on two inputs and one textarea; no state frame
    use: Merchant inquiry-form text input (input.__form-input) at surface-2::[data-omd-capture="3"]; capture 4 matches and the textarea (capture 5) is 414 x 50; border width 0px, so no border is declared
  merchant-checkbox:
    type: toggle
    backgroundColor: '#ffffff'
    border: '1px #999999'
    rounded: 4px
    size: 19px x 19px
    states: rest captured on six checkboxes; the checked property was not dumped, so no checked value is declared; no state frame
    use: Merchant inquiry-form checkbox (input type=checkbox) at surface-2::[data-omd-capture="6"]; captures 7 to 10 and 12 match
  careers-header-menu-item:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212429'
    rounded: 4px
    padding: 5.5px 12px
    height: 32px
    typography: 16px / 400 Pretendard
    states: default captured on five items; no state frame
    use: Careers-site header menu item (button.header__MenuItemContainer) at surface-3::[data-omd-capture="2"], 81 x 32; five per header (captures 2, 4, 6, 8, 10)
  careers-header-orange-item:
    type: button
    backgroundColor: '#ff3d00'
    textColor: '#ffffff'
    rounded: 4px
    padding: 5.5px 12px
    height: 32px
    typography: 16px / 400 Pretendard
    states: default captured; no state frame
    use: Careers-site header item in the orange variant of the same component (header__MenuItemContainer, iqSJex) at surface-3::[data-omd-capture="12"], 55 x 32
  careers-blue-action:
    type: button
    backgroundColor: '#388fff'
    textColor: '#ffffff'
    rounded: 15px
    padding: 10.5px 24px
    height: 48px
    typography: 16px / 400 Pretendard
    states: default captured; no state frame
    use: Careers-service marketing action in blue (button.button__Button, gPqMCK) at surface-3::[data-omd-capture="16"], 166 x 48; same component and geometry as the orange action
  careers-pill-action:
    type: button
    backgroundColor: '#ff3d00'
    textColor: '#ffffff'
    rounded: 24px
    padding: 10.5px 28px
    height: 48px
    typography: 16px / 400 Pretendard
    states: default captured; no state frame
    use: Careers-service wide orange action (button.button__Button, boFZhw) at surface-3::[data-omd-capture="21"], 214 x 48
  consumer-category-shortcut:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    size: 109px x 65px
    typography: 13px / 400 / 16.9px Pretendard Std Variable
    states: default captured on twelve shortcuts; no state frame
    use: Consumer-home category shortcut (a, flex column) at home::[data-omd-capture="4"]; twelve in one row (captures 4 to 15); the text style is its h3 label (home::h3), not the link container
  consumer-restaurant-card:
    type: card
    backgroundColor: transparent
    textColor: '#222222'
    size: 200px x 274px
    typography: 16px / 700 / 24px Pretendard Std Variable
    states: non-interactive; eight cards at 200 x 274 and two at 200 x 298, whose titles run to two lines
    use: 'Consumer-home restaurant card (article, w-[200px]) at home::article; the title is its h2 (home::h2, clamped to two lines) and the meta line its p (home::p, 12px / 400 / 18px, #666666); the article has no fill and a 0px radius, and the image corners were not sampled'
  consumer-bottom-tab:
    type: tab
    backgroundColor: transparent
    size: 120px x 56px
    states: default captured on four links; no state frame and no selected variant recorded
    use: Consumer bottom navigation link (a, flex-1) at home::[data-omd-capture="61"]; four links fill a 480px row at top 844, the last 56px of the 900px viewport; the icon and label sit in children whose style was not sampled
  consumer-modal-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    height: 21px
    typography: 14px / 400 / 21px Pretendard Std Variable
    states: default captured on two buttons; no state frame
    use: Text button on the consumer-home modal (MUI Modal over a rgba(0, 0, 0, 0.7) backdrop, open at capture) at home::[data-omd-capture="65"], 89 x 21; the second button (capture 66) is 35 x 21
fonts:
  roles:
    ui: Pretendard Std Variable
---

# CatchTable

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to CatchTable; reproduced for educational reference. Full prose: https://oh-my-design.kr/catchtable/design.md
