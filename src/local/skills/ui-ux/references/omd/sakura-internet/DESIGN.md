---
name: さくらインターネット
colors:
  primary: '#ff5577'
  canvas: '#ffffff'
  foreground: '#1d1d1d'
  inverse: '#f1f1f1'
  muted: '#6d6d75'
  hairline: '#cccccf'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 28px
    use: Dominant public corporate body and service-card text.
  section-title:
    fontSize: 28px
    fontWeight: 600
    lineHeight: 36.4px
    use: Observed public corporate section heading.
  tab:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 28px
    use: Observed case-study tab label.
rounded:
  card: 8px
  tab: 8px
  pill: 46px
spacing:
  sm: 8
  md: 16
  lg: 32
  xl: 40
components:
  service-initiative-list:
    type: card
    backgroundColor: transparent
    textColor: '#1d1d1d'
    rounded: 0px
    padding: 0px
    typography: 16px / 400 Noto Sans JP
    use: Static service-initiative list container, selector home::div.service-card.service-initiative-list.
  case-tab-selected:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#1d1d1d'
    border: '2px solid #ff5577'
    rounded: 8px
    padding: 16px
    height: 110px
    typography: 16px / 400 Noto Sans JP
    states: selected and tab-selected observed in supplied tab interaction captures; no other state value is promoted
    use: Selected case-study tab, selector home::[data-omd-capture=23].
fonts:
  roles:
    ui: Noto Sans JP
    brand: Haru TP M
---

# さくらインターネット

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to さくらインターネット; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/sakura-internet/DESIGN.md
