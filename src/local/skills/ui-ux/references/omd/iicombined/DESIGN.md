---
name: IICOMBINED
colors:
  ink: '#111111'
  primary: '#111111'
  on-primary: '#ffffff'
  ink-pure: '#000000'
  canvas: '#f3f4f6'
  on-image: '#ffffff'
  muted: '#858585'
  chip-selected: '#dfe3e8'
  outline: '#ababab'
typography:
  campaign:
    fontSize: 24px
    fontWeight: 400
    lineHeight: 1.17
    use: Campaign slide titles over the home hero, white, gentleMonsterSerif
  collection-title:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.2
    use: Listing title at the head of the sunglasses listing (h1), gentleMonsterSerif
  product-title:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.29
    use: Product name on the product page (h1), gentleSerifBoldKo
  section:
    fontSize: 17px
    fontWeight: 350
    lineHeight: 1.29
    use: Section headings lower on the product page (h2.title), gentleSansLightKo
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Page body text on all three pages, gentleSansRegularKo
  nav:
    fontSize: 13px
    fontWeight: 350
    lineHeight: 1.38
    use: Top menu items in the header, gentleSansLightKo
  product-name:
    fontSize: 12px
    fontWeight: 350
    lineHeight: 1.42
    use: Product names under product images (h3), gentleSansLightKo
  meta:
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.45
    use: Grey secondary lines under products on home, gentleSansRegularKo
  button:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.67
    use: Label of the filled product-page action, gentleSansRegularKo
  footer:
    fontSize: 12px
    fontWeight: 350
    lineHeight: 1.42
    use: Footer links, gentleSansLightKo
rounded:
  button: 8px
  pill: 25px
  chip: 35px
spacing:
  pill-x: 23
  button-x: 10
  chip-y: 7
  chip-x: 12
components:
  primary-button:
    type: button
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 10px
    height: 48px
    typography: 12px / 400 / 20px gentleSansRegularKo
    states: rest only; the collector recorded no state frame, and it was not pointer-probed because it is the filled action in the product page's purchase area, where a press could add the item to the bag
    use: The one filled action on the product page at surface-3::[data-omd-capture="59"] (button.btn-common), 327 x 48; its label was not read
  campaign-pill:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 25px
    padding: 0px 23px
    height: 36px
    typography: 11px / 400 gentleSansRegularKo (label span)
    states: '구매하기: hover and pressed show no change within the probe''s compared scope (self, its one label span, three ancestor levels; transitions compute 0s); 캠페인 보기: hover and pressed unmeasured because :hover did not match; focus not measured'
    use: '구매하기 / 캠페인 보기 pair on the home hero slides at home::[data-omd-capture="56"] (88 x 36) and 57 (101 x 36); the anchor itself computes #111111 at 16px, but the visible label is its child span in #ffffff at 11px (fixed probe)'
  load-more-button:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    border: '1px solid #ababab'
    rounded: 8px
    height: 44px
    typography: 12px / 350 gentleSansLightKo
    states: rest only; no state frame
    use: Load-more control under the product grid of the sunglasses listing at surface-2::[data-omd-capture="196"] (button.btn-more), 184 x 44
  filter-chip:
    type: tab
    backgroundColor: transparent
    border: '1px solid #dfe3e8'
    rounded: 35px
    padding: 7px 12px
    height: 33px
    selected: 'bg #dfe3e8 with a 1px #dfe3e8 border on the item carrying class on (capture 56)'
    states: selected variant read from rest values (capture 56 against 57); no pointer frame
    use: Filter chips at the top of the sunglasses listing at surface-2::[data-omd-capture="57"], 59 x 33; the anchors compute font-size 0px, so their labels sit in children that were not captured and no label colour or font is claimed
  header-menu-item:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    height: 18px
    typography: 13px / 350 / 18px gentleSansLightKo
    states: 'rest only; over the home hero the same items read #ffffff (home::[data-omd-capture="0"]), so the header recolours with the page'
    use: Top menu items in the header of the listing and product pages at surface-2::[data-omd-capture="0"], 48 x 18
  underlined-text-action:
    type: button
    backgroundColor: transparent
    textColor: '#111111'
    height: 16px
    typography: 11px / 400 / 16px gentleSansRegularKo, uppercase, underlined with a 3px offset
    states: rest only; no state frame
    use: Underlined uppercase text actions repeated 47 times on home at home::[data-omd-capture="72"], 104 x 16; labels were not read
fonts:
  roles:
    display: gentleMonsterSerif
    body: gentleSansRegularKo
    light: gentleSansLightKo
    serif-bold: gentleSerifBoldKo
---

# IICOMBINED

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to IICOMBINED; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/iicombined/DESIGN.md
