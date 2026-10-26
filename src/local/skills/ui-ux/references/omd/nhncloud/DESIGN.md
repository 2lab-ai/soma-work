---
name: NHN Cloud
colors:
  primary: '#125de6'
  on-primary: '#ffffff'
  dark: '#111111'
  muted: '#727781'
  border: '#51565f'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Corporate-marketing body sample
  cta:
    fontSize: 15px
    fontWeight: 400
    use: 40px corporate header CTA
  cta-lg:
    fontSize: 17px
    fontWeight: 500
    use: 48px corporate section CTA
rounded:
  cta: 30px
  control: 6px
  menu: 8px
spacing:
  cta-sm-y: 8
  cta-sm-x: 19
  cta-lg-y: 10
  cta-lg-x: 27
  menu-y: 8
  menu-x: 16
components:
  corporate-header-cta:
    type: button
    backgroundColor: '#125de6'
    textColor: '#ffffff'
    border: '1px solid #125de6'
    rounded: 30px
    padding: 8px 19px
    height: 40px
    typography: 15px / 400 Pretendard Variable
    states: 'hover and pressed sampled on this selector; both frames record the fill #1446c8, with text and border colours equal to rest. One element, no sibling; the two frames agree. No focus frame. Corrected 2026-09-29: the July text said no state value was inferred while the value was already declared'
    use: Corporate-marketing header CTA, selector home::[data-omd-capture=13]
    hover: 'bg #1446c8'
    pressed: 'bg #1446c8'
  corporate-section-cta:
    type: button
    backgroundColor: '#125de6'
    textColor: '#ffffff'
    border: '1px solid #125de6'
    rounded: 30px
    padding: 10px 27px
    height: 48px
    typography: 17px / 500 Pretendard Variable
    states: 'default captured; the capture holds no hover, pressed, or focus frame for this element (corrected 2026-09-29: the July text gave it the state names of other rounded-30 buttons, capture 13 and 15-17)'
    use: Corporate-marketing section CTA, selector home::[data-omd-capture=29]
  resource-menu-trigger:
    type: button
    textColor: '#727781'
    border: '1px solid #51565f'
    rounded: 6px
    padding: 10px 16px
    height: 42px
    typography: 16px / 400 Pretendard Variable
    states: expanded and menu-open observed
    use: Corporate-marketing resource/menu trigger, selector home::[data-omd-capture=130]
  corporate-outline-pill:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 30px
    padding: 11px 28px
    height: 50px
    typography: 17px / 500 / 26px
    hover: 'fg #c8ccd4, border #c8ccd4'
    pressed: 'fg #c8ccd4, border #c8ccd4'
    states: rest on four pills (capture 14-17); hover and pressed sampled on three of them (15-17), all recording the same value; no focus frame
    use: Corporate-marketing outline pill at home::[data-omd-capture="15"]; the white label implies a dark section behind it, whose fill was not sampled
  corporate-utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px
    height: 26px
    typography: 17px / 500 / 26px
    hover: 'fg #125de6'
    pressed: 'fg #125de6'
    states: rest, hover, and pressed sampled on both header utility controls (capture 9 and 10), which record the same values; no focus frame
    use: Corporate-marketing header utility control at home::[data-omd-capture="9"] (button) and "10" (link), both classed hover:text-blue-700
  corporate-gnb-item:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px 18px
    height: 72px
    typography: 17px / 500 / 26px
    states: rest sampled on eight items (capture 1-8); the hover and pressed frames record near-black text that differs per item and between the two frames (rgb(17, 17, 17) to rgb(17, 19, 23)), a transition in progress, so no state value is declared
    use: Corporate-marketing top navigation item at home::[data-omd-capture="2"]; the first item drops its left padding and the last its right
  corporate-footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#727781'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 14px / 400 / 20px
    states: default captured; no pointer-state sample
    use: Corporate-marketing footer link at home::[data-omd-capture="58"] (74 occurrences of this variant)
  resource-menu:
    type: card
    backgroundColor: '#111111'
    textColor: '#ffffff'
    border: '1px #727781'
    rounded: 8px
    padding: 8px 0px
    size: 180px x 378px
    typography: 16px / 400 / 24px
    shadow: 0px 4px 8px rgba(0, 0, 0, 0.06)
    states: expanded and menu-open observed
    use: Expanded corporate-marketing resource menu (role=menu) at home::[data-omd-interaction-capture="menu-0-0"], opened from the resource-menu trigger
  resource-menu-item:
    type: button
    backgroundColor: transparent
    textColor: '#727781'
    rounded: 0px
    padding: 8px 16px
    size: 178px x 36px
    typography: 17px / 400 / 26px
    states: observed only inside the expanded menu; no pointer-state sample
    use: Item (role=menuitem) inside the expanded resource menu at home::[data-omd-interaction-capture="menu-0-2"]; "menu-0-3" records the same values
  docs-header-cta:
    type: button
    backgroundColor: '#125de6'
    textColor: '#ffffff'
    rounded: 30px
    padding: 9px 20px
    height: 40px
    typography: 15px / 300 / 22px
    states: default captured; no pointer-state sample
    use: Documentation-chrome header CTA (a.link-text) on docs.nhncloud.com at surface-3::[data-omd-capture="3"]; not the corporate CTA token
  docs-category-link:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    rounded: 0px
    padding: 0px 0px 0px 60px
    height: 46px
    typography: 14px / 400 / 46px
    selected: 'fg #125de6'
    hover: 'fg #125de6, bg #e9f1ff'
    pressed: 'fg #125de6, bg #e9f1ff'
    states: 'rest, hover, and pressed sampled on nine category links (capture 4 and 16-23), all recording the same values; the current category (capture 5) is #125de6 at rest and takes the same #e9f1ff fill; no focus frame'
    use: Documentation sidebar category link (a.gnb_link.category_menu) on docs.nhncloud.com at surface-3::[data-omd-capture="4"]
  docs-page-link:
    type: tab
    backgroundColor: transparent
    textColor: '#555555'
    rounded: 0px
    padding: 8px 37px 8px 33px
    height: 36px
    typography: 13px / 300 / 16px
    selected: 'fg #125de6'
    hover: 'fg #125de6, bg #e9f1ff'
    pressed: 'fg #125de6, bg #e9f1ff'
    states: 'rest, hover, and pressed sampled on nine page links (capture 7-15), all recording the same values; the current page (capture 6, class current) is #125de6 at rest and takes the same #e9f1ff fill; no focus frame'
    use: Documentation sidebar page link (a.gnb_link.link_txt) on docs.nhncloud.com at surface-3::[data-omd-capture="7"]
fonts:
  roles:
    ui: Pretendard Variable
---

# NHN Cloud

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NHN Cloud; reproduced for educational reference. Full prose: https://oh-my-design.kr/nhncloud/design.md
