---
name: Pinterest
colors:
  primary: '#e60023'
  consumer-ink: '#211922'
  muted: '#62625b'
  secondary-surface: '#e5e5e0'
  control-border: '#91918c'
  canvas: '#ffffff'
  business-ink: '#111111'
  business-action: '#111111'
  on-action: '#ffffff'
typography:
  consumer-ui:
    fontSize: 12px
    fontWeight: 400
    use: Repeated consumer product/auth control sample
  consumer-form:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Consumer auth form input
  business-body:
    fontSize: 16px
    fontWeight: 400
    use: Business-marketing actions and body samples
  business-tab:
    fontSize: 15px
    fontWeight: 700
    use: Business-marketing tab
rounded:
  consumer-control: 16px
  business-tab: 12px
  business-action: 30px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 20
components:
  consumer-primary-action:
    type: button
    backgroundColor: '#e60023'
    textColor: '#000000'
    border: 2px solid transparent
    rounded: 16px
    padding: 6px 14px
    typography: 12px / 400 Pin Sans
    states: Default baseline captured; no changed interaction style promoted.
    use: Consumer header action; home::[data-omd-capture=7]
    height: 48px
    pressed: 'bg #b2001b, transform matrix(0.944444, 0, 0, 0.944444, 0, 0) (:hover + :active)'
    focus: 'border #ffffff, outline #435ee5 solid 2px on :focus-visible'
  consumer-secondary-action:
    type: button
    backgroundColor: '#e5e5e0'
    textColor: '#000000'
    border: 2px solid transparent
    rounded: 16px
    padding: 6px 14px
    typography: 12px / 400 Pin Sans
    states: Default baseline captured; no changed interaction style promoted.
    use: Consumer header secondary action; home::[data-omd-capture=8]
  consumer-form-input:
    type: input
    textColor: '#000000'
    border: '1px solid #91918c'
    rounded: 16px
    padding: 11px 15px
    typography: 16px / 400 Pin Sans
    states: Default baseline captured; no changed focus or error style promoted.
    use: Consumer auth input; home::[data-omd-capture=19]
  business-action:
    type: button
    backgroundColor: '#111111'
    textColor: '#ffffff'
    rounded: 30px
    padding: 0px 20px
    typography: 16px / 400 PinterestSansPro
    states: Default baseline captured; no changed interaction style promoted.
    use: Business-marketing action; surface-3::[data-omd-capture=9]
  business-outline-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#111111'
    rounded: 30px
    padding: 0px 20px
    typography: 16px / 400 PinterestSansPro
    states: Default baseline captured; no changed interaction style promoted.
    use: Business-marketing outline action; surface-3::[data-omd-capture=10]
  business-tab:
    type: tab
    textColor: '#111111'
    rounded: 12px
    padding: 14px 16px
    typography: 15px / 700 PinterestSansPro
    states: 'selected observed: #ffffff text; interaction capture records tab-selected'
    use: Business-marketing tab; surface-3::[data-omd-capture=16]
fonts:
  roles:
    ui: Pin Sans
    business-marketing: PinterestSansPro
---

# Pinterest

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Pinterest; reproduced for educational reference. Full prose: https://oh-my-design.kr/pinterest/design.md
