---
name: POZAlabs
colors:
  primary: '#000000'
  ink: '#000000'
  secondary: '#666666'
  charcoal: '#333333'
  border-hover: '#949494'
  inverse: '#e7e7e7'
  inverse-muted: '#a0a0a0'
  white: '#ffffff'
typography:
  display-hero:
    fontSize: 129.6px
    fontWeight: 400
    lineHeight: 1.22
    use: 'Home hero headline (Ignite your creativity), right-aligned, #000000, 158px line'
  display:
    fontSize: 60px
    fontWeight: 300
    lineHeight: 1.45
    use: 'Page headline on /ko/service/ (음악을 만드는 새로운 방법, #000000) and the closing statement on its dark band (#e7e7e7), 87px line'
  headline:
    fontSize: 40px
    fontWeight: 300
    lineHeight: 1.45
    use: 'Service names and kicker lines on /ko/service/ (AI 생성 음악 in #666666, 음악을 위한 캔버스 in #000000), 58px line'
  tagline:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.375
    use: 'The code-style statement under the home hero (with pozalabs as technology: expand(your_creativity)), 44px line'
  body-lg:
    fontSize: 20px
    fontWeight: 350
    lineHeight: 1.6
    use: 'Mood album titles and lead copy on /ko/about/ (lead in #333333) and service feature lists, 32px line'
  section-label:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Grey section labels on /ko/about/, #666666, 32px line'
  button:
    fontSize: 18px
    fontWeight: 350
    lineHeight: 1.67
    use: '보러 가기 labels on /ko/service/, #ffffff, 30px line'
  nav:
    fontSize: 16px
    fontWeight: 350
    lineHeight: 1.75
    use: Header navigation (홈, 소개, 서비스, 연구, 문의, 채용), 28px line
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Document default on all three pages, Garet then Pretendard Variable, 24px line
  label:
    fontSize: 14px
    fontWeight: 350
    lineHeight: 1.43
    use: The English pill and the footer copyright line (#666666), 20px line
rounded:
  none: 0px
  card: 8px
  pill: 9999px
spacing:
  pill-x: 14
  pill-y: 7
  list-y: 20
  footer-x: 20
components:
  language-pill:
    type: button
    textColor: '#333333'
    border: 1px solid rgba(0, 0, 0, 0.2)
    rounded: 9999px
    padding: 7px 14px
    height: 36px
    typography: 14px / 350 / 20px Garet
    hover: 'border 1px solid #949494'
    pressed: 'border 1px solid #949494'
    states: the border darkens after a 0.15s cubic-bezier(0.4, 0, 0.2, 1) colour transition; label and fill unchanged; focus not measured
    use: English link at the right end of the header on all three pages at home::[data-omd-capture="5"], 102 x 36, with a globe icon
  nav-item:
    type: tab
    textColor: '#666666'
    height: 28px
    typography: 16px / 350 / 28px Garet
    selected: 'fg #000000 on the current page (소개 on /ko/about/, 서비스 on /ko/service/); on home every item is #000000'
    hover: 'fg #333333 with a solid #333333 underline'
    pressed: same as hover
    states: non-current items change without transition (all 0s); the current item shows no change on hover or press; focus not measured
    use: Header navigation at surface-2::[data-omd-capture="2"] on a white header
  album-card:
    type: card
    rounded: 8px
    shadow: rgba(0, 0, 0, 0.05) 2px 4px 10px 0px
    size: 190px x 190px
    use: Mood album artwork tiles on /ko/about/ (Uplifting, Relaxing, Hopeful ... 16 instances), each with its title below in 20px / 350; the only shadowed element on the site
  service-cta:
    type: button
    textColor: '#ffffff'
    typography: 18px / 350 / 30px Garet
    size: 67px x 30px (label)
    states: the label shows no change on hover or press; the button's fill is painted by a layer outside the probe's scope (the label, its link and two wrappers are transparent), so no background is declared
    use: 보러 가기 under eapy, LAIVE and viodio on /ko/service/
  feature-list-item:
    type: listItem
    textColor: '#000000'
    padding: 20px 0px
    typography: 20px / 350 / 32px Garet
    use: Feature bullets under each service on /ko/service/ (실시간 MIDI 샘플 생성, 로열티 프리 ...), 800 x 72 rows
fonts:
  roles:
    display: Garet
    korean: Pretendard Variable
---

# POZAlabs

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to POZAlabs; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/pozalabs/DESIGN.md
