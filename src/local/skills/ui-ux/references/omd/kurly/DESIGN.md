---
name: Kurly
colors:
  primary: '#5f0080'
  canvas: '#ffffff'
  foreground: '#333333'
  body: '#464c52'
  muted: '#999999'
  border: '#dfe4eb'
  control-background: '#f7f7f7'
  control-muted: '#b5b5b5'
typography:
  utility:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 14px
    use: Repeated visible text and button default in the supplied desktop commerce capture.
  category-tab:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 23.94px
    use: Inactive category tab in the home and new-products surfaces; selected and hover/pressed samples are separately observed.
  input:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 16px
    use: Captured form input, including the collector's error-state sample; letter-spacing -0.33px. Corrected 2026-09-29 from 20px, which no input sample records.
rounded:
  xs: 2px
  sm: 4px
spacing:
  xxs: 2
  xs: 4
  sm: 8
  md: 16
components:
  category-tab:
    type: button
    textColor: '#b5b5b5'
    typography: 18px / 400 / Pretendard
    states: 'Selected tab is #5f0080 at 18px / 500; the captured inactive tab changed to #5f0080 at both hover and pressed.'
    use: Category control at home::[data-omd-capture="7"] and surface-3::[data-omd-capture="7"].
    hover: '#5f0080'
    pressed: '#5f0080'
  form-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    typography: 16px / 400 / Pretendard
    error: Error state was captured at home::[data-omd-interaction-capture="form-error-0-0"] and surface-3::[data-omd-interaction-capture="form-error-0-0"]; sampled computed values matched the retained default sample.
    use: Captured form input only; no focus, disabled, or success variant is specified.
  product-list-article:
    type: card
    textColor: '#333333'
    rounded: 0px
    typography: 14px / 400 / Pretendard
    use: Article wrapper in the new-products product list at surface-3::article; 249px sampled width, with no card surface or hover variant observed.
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#464c52'
    border: bottom 1px, transparent at rest
    rounded: 0px
    padding: 0px
    height: 21px
    typography: 16px / 500 / 20px
    hover: 'fg #5f0080, bottom border #5f0080'
    pressed: 'fg #5f0080, bottom border #5f0080'
    states: rest, hover, and pressed sampled on six links on home (capture 14-19) and the same six on new-products, all recording the same values; no focus frame
    use: Header navigation link (a.css-1m0tfai) at home::[data-omd-capture="14"]
  product-list-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px #dfe4eb'
    rounded: 4px
    padding: 0px
    size: 249px x 36px
    typography: 14px / 400 / 14px
    states: default captured; no pointer-state sample
    use: Repeated product-list button on new-products at surface-3::[data-omd-capture="148"] (58 occurrences of this variant)
    height: 20px
  compact-list-control:
    type: button
    backgroundColor: '#f7f7f7'
    textColor: '#b5b5b5'
    rounded: 2px
    padding: 2px 0px 3px
    size: 22px x 22px
    typography: 13px / 400 / 17px
    states: default captured; no pointer-state sample
    use: Compact product-list control on new-products at surface-3::[data-omd-capture="60"] (18 occurrences of this variant)
  outline-button:
    type: button
    backgroundColor: transparent
    textColor: '#333333'
    border: '1px #e2e2e2'
    rounded: 3px
    padding: 0px
    size: 140px x 40px
    typography: 14px / 400 / 39px
    states: default captured; no pointer-state sample
    use: 140 x 40 outline button at home::[data-omd-capture="92"]; the variant occurs four times across home and category-list
fonts:
  roles:
    sans: Pretendard
---

# Kurly

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Kurly; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/kurly/DESIGN.md
