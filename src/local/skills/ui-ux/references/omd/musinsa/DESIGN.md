---
name: Musinsa
colors:
  primary: '#000000'
  canvas: '#ffffff'
  foreground: '#000000'
  muted: '#666666'
  line: '#ebebeb'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0px
    use: Repeated storefront body and product text
  nav:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.375
    letterSpacing: 0px
    use: 56px global-navigation store link
rounded:
  square: 0px
  icon: 2px
  control: 4px
spacing:
  xs: 4
  sm: 6
  md: 8
  lg: 24
components:
  gnb-store-link:
    type: button
    textColor: rgba(255,255,255,0.8)
    rounded: 0px
    padding: 0px 8px
    height: 56px
    typography: 16px / 500 / Pretendard
    states: default captured only; the capture holds no pointer-state frame for any element on either storefront (interaction coverage 0 counts expansions only)
    use: Global-navigation store link on both captured storefronts
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#8a8a8a'
    rounded: 4px
    padding: 8px 28px 8px 8px
    height: 36px
    typography: 14px / 400 / Pretendard
    states: default captured only; the capture holds no pointer-state frame for any element on either storefront (interaction coverage 0 counts expansions only)
    use: Home storefront search input
  product-image-link:
    type: card
    rounded: 0px
    padding: 0px
    height: 312px
    typography: 14px / 400 / Pretendard
    use: MUSINSA STANDARD product-image link in the listing grid
  product-utility-button:
    type: button
    textColor: '#000000'
    rounded: 0px
    padding: 4px
    height: 28px
    typography: 14px / 400 / Pretendard
    states: default captured only; the capture holds no pointer-state frame for any element on either storefront (interaction coverage 0 counts expansions only)
    use: Product-card utility control on the MUSINSA STANDARD storefront
  home-tab-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 14px 7px
    height: 48px
    typography: 14px / 400 / 21px Pretendard
    states: rest captured on five tabs, none marked selected; the capture holds no pointer-state frame for any element on either storefront
    use: Main-storefront category tab link (TabItem__TabLink) at home::[data-omd-capture="22"] through "26"
  floating-action-button:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.92)
    border: '1px solid #ebebeb'
    rounded: 100%
    size: 40px x 40px
    states: rest captured; the capture holds no pointer-state frame for any element on either storefront
    use: Main-storefront white floating action button (_fab__button--white) at home::[data-omd-capture="32"]; "36" records the same values. It carries an icon, not text, so no label colour is claimed
  global-filter-toggle:
    type: toggle
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 100%
    size: 40px x 40px
    typography: 12px / 500 / 18px Pretendard
    selected: 12px / 600, class _fab-global-filter__button--active
    states: inactive rest and one active variant captured as static markup; the active option's own fill is transparent and the fill behind it was not sampled, so neither the active fill nor its text colour is claimed; the capture holds no pointer-state frame for any element on either storefront
    use: Main-storefront floating global filter option at home::[data-omd-capture="34"] and "35"; active sample "33"
  outline-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #e0e0e0'
    rounded: 4px
    padding: 0px 11px
    height: 32px
    typography: 14px / 400 / 21px Pretendard
    states: rest captured on three controls; the capture holds no pointer-state frame for any element on either storefront
    use: MUSINSA STANDARD outline button at surface-2::[data-omd-capture="36"]; "37" (an anchor) and "38" record the same values
  search-keyword-tag:
    type: badge
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 18px
    typography: 14px / 400 / 18px Pretendard
    states: rest captured on 26 tags; the capture holds no pointer-state frame for any element on either storefront
    use: MUSINSA STANDARD search keyword tag (UISearchTags__Tag) at surface-2::[data-omd-capture="40"]; all 26 tags record the same values, with no fill, border, or padding
fonts:
  roles:
    sans: Pretendard
---

# Musinsa

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Musinsa; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/musinsa/DESIGN.md
