---
name: MIXI
colors:
  canvas: '#ffffff'
  ink: '#000000'
  muted: '#5c5c5c'
  news-red: '#e5004d'
typography:
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.8
    use: Observed about and conduct-guideline body copy
  header-navigation:
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.15
    use: Observed corporate-header global-navigation control
  guideline-heading:
    fontSize: 35px
    fontWeight: 600
    lineHeight: 1.5
    use: Observed conduct-guideline section heading
rounded:
  control: 3px
  news-image: 5px
components:
  header-global-navigation:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px
    height: 70px
    typography: 13px / 600 Noto Sans JP
    states: Default baseline captured; no changed interaction state captured.
    use: Observed header global-navigation button at home::[data-omd-capture=3].
  news-category-label:
    type: badge
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #000000'
    rounded: 3px
    padding: 4px 9px 5px
    height: 22px
    typography: 11px / 600 Noto Sans JP
    use: Observed news-card category label at home::div.c-newsCard__info--category.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: Noto Sans JP
---

# MIXI

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MIXI; reproduced for educational reference. Full prose: https://oh-my-design.kr/mixi/design.md
