---
name: 長榮航空
colors:
  canvas: '#ffffff'
  foreground: '#000000'
  on-green: '#ffffff'
  green-panel: '#4b7d6b'
  accent: '#cc4b00'
  hairline: '#666666'
typography:
  body:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 1.5
    use: Repeated public page body only; the computed Dotum-first stack has no matching loaded FontFace in the supplied evidence.
  nav-label:
    fontSize: 14px
    fontWeight: 300
    lineHeight: 1.2
    use: Observed public navigation-list label only; no named EVA UI family is claimed.
  accordion-label:
    fontSize: 30px
    fontWeight: 500
    use: Awards-page accordion trigger label only.
rounded:
  square: 0px
  media: 3px
  input: 3px
spacing:
  xs: 5
  sm: 10
  md: 20
  lg: 30
components:
  booking-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    border: '1px solid #666666'
    rounded: 3px
    padding: 10px 10px 10px 50px
    height: 44px
    typography: 16px / 400 / unresolved computed stack
    states: default captured; the interaction log records booking-tab selection only, not focus, error, disabled, or pressed values
    use: Home booking text field; selector home::[data-omd-capture=151].
  booking-widget-tab:
    type: tab
    backgroundColor: '#4b7d6b'
    textColor: '#ffffff'
    rounded: 24px
    padding: 1px 10px
    height: 42px
    typography: 16px / 500 / unresolved computed stack
    states: selected and tab-selected were captured; no hover, focus, pressed, or disabled values were captured
    use: Home booking-widget selected tab; selector home::[data-omd-capture=145].
  award-accordion:
    type: button
    textColor: '#cc4b00'
    border: '0px 0px 1px #eeeeee'
    rounded: 0px
    padding: 30px 70px 30px 40px
    height: 96px
    typography: 30px / 500 / unresolved computed stack
    states: default captured only; no expanded, hover, focus, pressed, or disabled value was captured
    use: Awards-page accordion trigger; selector awards::[data-omd-capture=144].
  green-information-card:
    type: card
    backgroundColor: '#4b7d6b'
    textColor: '#ffffff'
    rounded: 0px 0px 3px 3px
    padding: 20px
    typography: 16px / 300 / unresolved computed stack
    use: About-page card information panel; selector about::div.card-info.card-info--green.
  footer-list-item:
    type: listItem
    textColor: '#ffffff'
    rounded: 0px
    padding: 10px 0px
    typography: 16px / 300 / unresolved computed stack
    use: Public footer list row; selector home::li.footer-listItem.
---

# 長榮航空

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 長榮航空; reproduced for educational reference. Full prose: https://oh-my-design.kr/evaair/design.md
