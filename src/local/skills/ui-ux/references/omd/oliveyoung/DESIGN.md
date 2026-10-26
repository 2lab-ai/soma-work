---
name: Olive Young
colors:
  storefront-canvas: '#ffffff'
  storefront-ink: '#131518'
  storefront-body: '#666666'
  storefront-muted: '#888888'
  storefront-line: '#ebebeb'
  storefront-current: '#2f3030'
  corporate-brand-green: '#82dc28'
typography:
  storefront-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20
    letterSpacing: '-0.56px'
    use: Storefront home body and navigation text
  corporate-display:
    fontSize: 25.2px
    fontWeight: 700
    lineHeight: 35.28
    letterSpacing: 0px
    use: Corporate home display copy
rounded:
  outline-control: 4px
  search-field: 5px
  pagination-current: 12px
spacing:
  search-x: 14
  search-end: 10
components:
  pagination-current:
    type: tab
    backgroundColor: '#2f3030'
    textColor: '#ffffff'
    rounded: 12px
    typography: 14px/700/Montserrat
    active: Current carousel pagination item; selected markup observed
    use: 24px current item in storefront home carousel pagination
  gnb-category-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 44px
    typography: 16px / 700 / 44px Montserrat
    hover: 'fg #e02020'
    pressed: 'fg #e02020'
    states: rest, hover, and pressed sampled on nine links that all record the same values; a focus frame was also recorded, but it followed a mouse press and is not a keyboard :focus-visible measurement, so no focus value is declared
    use: Storefront home main navigation link at home::[data-omd-capture="14"] through "22"
  utility-link:
    type: tab
    backgroundColor: transparent
    textColor: '#333333'
    rounded: 0px
    padding: 0px
    height: 14px
    typography: 12px / 400 / 30px Montserrat
    states: rest captured; no pointer-state frame was sampled for these links
    use: Storefront header utility link at home::[data-omd-capture="0"]; "1" through "6" record the same values
  category-menu-trigger:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #dddddd (left and right edges only)'
    rounded: 0px
    padding: 0px 0px 0px 27px
    height: 44px
    typography: 15px / 700 / 44px Montserrat
    states: rest captured; no pointer-state frame was sampled for it
    use: Storefront category-menu trigger at home::[data-omd-capture="13"], at the start of the main navigation row
  category-menu-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px 23px
    height: 31px
    typography: 14px / 700 / 31px Montserrat
    states: rest captured on twelve links; only one link was state-sampled, and its hover and pressed frames add a translucent black fill, rgba(0, 0, 0, 0.8), that no sibling sample or rest colour in the capture confirms, so no state value is declared; no focus frame was sampled
    use: Storefront category list link (main_menu) at home::[data-omd-capture="23"] through "34"; the white text implies a backdrop fill that was not part of the sampled elements and is not claimed
  search-field:
    type: input
    backgroundColor: transparent
    textColor: '#131518'
    rounded: 5px
    padding: 0px 10px 0px 14px
    height: 38px
    typography: 14px / 400 / 20px
    states: rest captured; no focus, typed, error, autocomplete, or pointer-state frame was sampled
    use: Storefront header search input (header_search_input) at home::[data-omd-capture="8"]; its computed family is system-resolved Arial, not an Olive Young font asset, and the input itself has no fill or border, so any visible field frame belongs to a wrapper the capture did not sample
  wishlist-control:
    type: button
    backgroundColor: '#ffffff'
    border: '1px solid #ebebeb'
    rounded: 0px
    size: 40px x 40px
    states: rest captured on 29 product-grid controls; no pointer-state or active-icon frame was sampled
    use: Storefront product-grid wishlist control (btn_zzim jeem) at home::[data-omd-capture="85"]; its glyph is not text (font-size 0px), so no label colour or type style is claimed
  product-thumbnail:
    type: card
    backgroundColor: '#ffffff'
    rounded: 0px
    size: 215px x 215px
    states: rest captured; no pointer-state frame was sampled
    use: 'Storefront product-grid thumbnail link (prd_thumb) at home::[data-omd-capture="83"]; its computed #666666 14px / 400 text is the inherited body style, not a label style'
  outline-control:
    type: button
    backgroundColor: transparent
    border: '1px solid #dddddd'
    rounded: 4px
    size: 335px x 40px
    states: rest captured; no pointer-state frame was sampled
    use: Storefront outline button (.btn) at home::[data-omd-capture="66"]; "79" records the same values. Its computed white text on a transparent fill cannot be the visible label colour, so no foreground is claimed
fonts:
  roles:
    storefront: Montserrat
    corporate: CJONLYONENew
---

# Olive Young

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Olive Young; reproduced for educational reference. Full prose: https://oh-my-design.kr/oliveyoung/design.md
