---
name: K bank
colors:
  primary: '#0114a7'
  secondary: '#4262ff'
  canvas: '#ffffff'
  foreground: '#000000'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Observed public-web home body and compact action control; do not generalize to native or authenticated banking.
  product-display:
    fontSize: 44px
    fontWeight: 700
    lineHeight: 59.4px
    letterSpacing: '-0.22px'
    use: Observed on the supplied public deposit-product pages only.
rounded:
  compact-action: 8px
  primary-action: 10px
  selected-tab: 0px
spacing:
  compact-action-inline: 14
  wide-action-inline: 28
components:
  public-home-shell:
    type: card
    backgroundColor: transparent
    rounded: 0px
    shadow: none
    use: Observed static home shell at home::div.mainCardWrapper.css-x2jyed; not a general card family.
  public-compact-action:
    type: button
    backgroundColor: '#4262ff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 0px 14px
    height: 40px
    typography: 16px / 400 / Pretendard K Edition
    states: default captured on all six routes; the bundle holds no state frame for any element
    use: Header compact action (button.css-1ags3br) at home::[data-omd-capture="3"], 96 x 40; computed oklch(0.571 0.235 268.681) on oklch(1 0 0); on the four product routes the same button computes a font stack led by -apple-system
  public-primary-action:
    type: button
    backgroundColor: '#0114a7'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0px 28px
    height: 48px
    typography: 16px / 400 / system stack led by -apple-system
    states: default captured; no state frame
    use: Primary action (button.css-1mbo487) at product-curious::[data-omd-capture="19"], 143 x 48; computed oklch(0.343 0.219 264.362); the home copy (home::[data-omd-capture="18"], 202 x 48) computes 14px / 400 Pretendard K Edition
  product-index-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#545b69'
    rounded: 0px
    padding: 10px 4px 12px
    height: 44px
    typography: 18px / 700 / 24.3px Pretendard K Edition
    states: rest on six tabs; capture 14 carries aria-selected=true and captures 15 to 19 false, yet all six compute the same colour, type and geometry, so no selected value is declared; no state frame
    use: Deposit-index product tab (button role=tab, css-1npe48v) at product-index::[data-omd-capture="15"], 180 x 44; computed oklch(0.47 0.024 264.308)
  product-choice-chip:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#2a2e36'
    border: '1px #ced4e2'
    rounded: 6px
    padding: 0px 12px
    height: 32px
    typography: 16px / 400 / system stack led by -apple-system
    states: default captured on thirteen chips; no state frame
    use: Deposit-index bordered choice (button.css-174ue6) at product-index::[data-omd-capture="21"], 74 x 32; computed oklch(1 0 0), text oklch(0.301 0.016 264.308), border oklch(0.87 0.02 267.27)
  product-detail-text-button:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 16px 20px
    height: 60px
    typography: 18.72px / 700 / system stack led by -apple-system
    states: default captured; no state frame and no expansion record
    use: Product-detail full-width text button (button.css-1kjxfqu) at product-curious::[data-omd-capture="14"], 1080 x 60; five on product-curious, four on product-rolling, three on product-one-card
  gnb-link:
    type: tab
    backgroundColor: transparent
    padding: 0px 24px
    height: 56px
    states: default captured, nine per route; no state frame
    use: Global navigation link (a.css-opegi4) at home::[data-omd-capture="4"], 110 x 56; its own 16px / 400 black equals the inherited page default, so no label style is declared
  product-soft-action:
    type: button
    backgroundColor: '#edf3ff'
    textColor: '#0114a7'
    rounded: 8px
    padding: 0px 14px
    height: 40px
    typography: 16px / 400 / system stack led by -apple-system
    states: default captured on product-curious (one) and product-one-card (thirteen); no state frame
    use: Product-page tinted action (button.css-162fgkl) at product-curious::[data-omd-capture="13"], 178 x 40; computed oklch(0.963 0.017 264.487) with oklch(0.343 0.219 264.362) text, the primary blue; the copies inside the ONE card benefit slides are 90 x 37
  benefit-slide-card:
    type: card
    backgroundColor: '#f7f8fb'
    rounded: 16px
    padding: 32px 0px
    size: 316px x 381px
    states: non-interactive carousel panel; eight at 316 x 381 and the fully visible slide at 340 x 410
    use: ONE card benefit slide (div role=tabpanel, swiper-slide benefit-slide) at product-one-card::[data-omd-capture="13"]; computed oklch(0.979 0.004 271.37); 12px right margin
  slide-pagination-tab:
    type: tab
    backgroundColor: transparent
    padding: 3px
    size: 18px x 18px
    states: three at rest in a 62 x 18 tablist; no aria-selected recorded, so no current-page style is declared; no state frame
    use: ONE card benefit carousel pagination (div role=tab, css-120l21f) at product-one-card::[data-omd-capture="31"]; the dot is drawn by a child that was not sampled; a 30 x 30 play toggle (capture 34) sits beside it
fonts:
  roles:
    ui: Pretendard K Edition
---

# K bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to K bank; reproduced for educational reference. Full prose: https://oh-my-design.kr/kbank/design.md
