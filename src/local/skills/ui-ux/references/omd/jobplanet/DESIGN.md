---
name: Jobplanet
colors:
  primary: '#00c362'
  primary-bright: '#00ff91'
  green-line: '#00c274'
  green-deep: '#003a1c'
  ink: '#333333'
  ink-strong: '#323438'
  nav: '#4b4c50'
  muted: '#686a6d'
  faint: '#a4a6ad'
  disabled: '#c5c7cc'
  canvas: '#ffffff'
  surface: '#f3f3f4'
  hairline: '#e5e6e9'
  on-primary: '#ffffff'
typography:
  section:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: Section titles (오늘의 추천, 커뮤니티 인기글)
  card-title:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Card / list-entry headline (stat chips)
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.4
    use: Top navigation links
  button:
    fontSize: 14px
    fontWeight: 700
    use: Primary CTA label
  input:
    fontSize: 16px
    fontWeight: 400
    use: Global search field text
  body:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Body copy, metadata, captions
  blog-hero:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1
    use: Tech-blog hero headline (IBM Plex Sans)
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 6
  base: 8
  md: 12
  lg: 16
  xl: 24
components:
  button-primary:
    type: button
    backgroundColor: '#00c362'
    textColor: '#ffffff'
    rounded: 5px
    height: 40px
    padding: 0 16px
    typography: 14px / 700
    use: Primary CTA (바로가기) — the single interactive green
  button-stat-chip:
    type: button
    backgroundColor: '#f3f3f4'
    textColor: '#333333'
    rounded: 8px
    height: 48px
    padding: 0 16px
    typography: 16px / 700
    use: Company stat entry (782개의 전∙현직자 리뷰)
  icon-button-round:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#333333'
    border: '1px solid #e5e6e9'
    rounded: 9999px
    padding: 6px
    height: 32px
    use: Circular carousel / utility icon button
  card-content:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#333333'
    rounded: 12px
    use: Story / content card on grey canvas, no shadow
  search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#333333'
    typography: 16px / 400
    height: 48px
    use: Global search field (기업, 공고, 콘텐츠 검색), borderless
  nav-link:
    type: tab
    textColor: '#4b4c50'
    typography: 15px / 400
    active: 'green #00c362 text on active'
    use: Top nav item (기업 랭킹, 커뮤니티, 채용)
  badge-highlight:
    type: badge
    backgroundColor: '#00ff91'
    textColor: '#333333'
    rounded: 4px
    typography: 13px / 400
    use: Neon-green highlight marker / emphasis tag
fonts:
  roles:
    body: Pretendard Variable
    blog: IBM Plex Sans
---

# Jobplanet

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Jobplanet; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/jobplanet/DESIGN.md
