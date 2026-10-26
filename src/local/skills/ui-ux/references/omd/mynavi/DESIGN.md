---
name: マイナビ
colors:
  body: '#323746'
  heading: '#000000'
  corporate-heading: '#0071bb'
  tab-fill: '#dddddd'
  info-surface: '#e7f6fd'
typography:
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.75
    use: Observed public corporate-home body baseline only.
  display:
    fontSize: 40px
    fontWeight: 400
    lineHeight: 1.75
    use: Observed service-directory and corporate-information page title only.
rounded:
  tab: 4px
spacing:
  list-indent: 39
  tab-y: 2
  tab-x: 3
components:
  service-filter-tab:
    type: tab
    backgroundColor: '#dddddd'
    textColor: '#000000'
    rounded: 4px
    padding: 2px 3px
    height: 38px
    states: Default static baseline observed; the supplied capture records 0 interactions and no changed tab state.
    use: Service-directory filter tab at surface-2::[data-omd-capture="14"] (class tab-show-item).
fonts:
  roles:
    display: Noto Sans JP
---

# マイナビ

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to マイナビ; reproduced for educational reference. Full prose: https://oh-my-design.kr/mynavi/design.md
