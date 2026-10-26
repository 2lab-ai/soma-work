---
name: Banksalad
colors:
  primary: '#13bd7e'
  action: '#06a96c'
  canvas: '#ffffff'
  foreground: '#111111'
  secondary: '#555c68'
  muted: '#9fa4b0'
  line: '#f0f2f5'
typography:
  heading:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: 0px
    use: Product and safety section headings
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Shared product body and list content
  label:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.625
    letterSpacing: '-0.08px'
    use: Prominent product labels and actions
  caption:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    letterSpacing: '-0.07px'
    use: Product metadata and helper text
rounded:
  chip: 6px
  action: 16px
  card: 24px
  full: 9999px
spacing:
  sm: 8
  md: 12
  base: 16
  lg: 24
components:
  primary-action:
    type: button
    backgroundColor: '#06a96c'
    textColor: '#ffffff'
    rounded: 16px
    padding: 16px 20px
    height: 56px
    typography: 16px / 700
    hover: 'overlay ::after #000000 opacity 0→0.04; bg stays #06a96c'
    pressed: 'overlay ::after #000000 opacity 0→0.04 (same as hover)'
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the same loan-flow button (real :hover, :active, and Tab to :focus-visible); every change is instant (transition all 0s)
    use: Full-width primary action in the public interest-rate flow
  filter-chip:
    type: button
    backgroundColor: rgba(19,189,126,0.15)
    textColor: '#13bd7e'
    rounded: 6px
    padding: 10px 12px
    typography: 16px / 500
    states: default captured; no safe active interaction expansion
    use: Content-directory category or filter action
  safety-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #f0f2f5'
    rounded: 24px
    padding: 24px
    use: Customer-safety action and guidance card
  disclosure-row:
    type: listItem
    backgroundColor: transparent
    textColor: '#272a30'
    rounded: 0px
    padding: 24px 20px
    typography: '16px / 700 (label span; the button''s own computed style is #000000 16px / 400)'
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29; the expanded state was not opened
    use: Expandable disclosure row on a public card product detail
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    padding: 0px 22px
    height: 26px
    typography: 16px / 700 / Pretendard, -0.08px tracking
    hover: 'fg #13bd7e'
    pressed: 'fg #13bd7e'
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: 'hover and pressed state samples captured 2026-07-12 on all 11 header links across four surfaces (44 of 44 read fg #13bd7e); re-measured 2026-09-29 on ''카드'' with real :hover and :active; keyboard focus measured 2026-09-29'
    use: Sticky desktop header menu link (카드, 대출, 예적금, 무료 건강 검사 …)
  hero-pill-cta:
    type: button
    backgroundColor: '#13bd7e'
    textColor: '#ffffff'
    rounded: 41px
    padding: 10px 20px
    height: 41px
    typography: 18px / 500 / Pretendard
    shadow: 0 4px 9px rgba(0,0,0,0.15)
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 (the hero carousel auto-advances, so the pill was read 1.5 s after load)
    use: Home hero carousel pill '뱅크샐러드 사용해보기'; other slides recolour the same pill
  hero-outline-pill:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#13bd7e'
    border: '1px solid #13bd7e'
    rounded: 41px
    padding: 10px 20px
    height: 43px
    typography: 18px / 500 / Pretendard
    shadow: 0 4px 9px rgba(0,0,0,0.15)
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 in a run with this control alone
    use: Home hero secondary pill '서비스 더 알아보기'
  safety-link-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#272a30'
    border: '1px solid #f0f2f5'
    rounded: 24px
    padding: 28px 24px
    size: 564px x 190px
    typography: 24px / 700 (title h2)
    shadow: '0 8px 24px #dce9f3'
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'no visible indication: outline none and no other property changes (measured 2026-09-29)'
    states: default captured 2026-07-12 (three link cards, 564px and 272px wide); hover, pressed and keyboard focus measured 2026-09-29 on the first
    use: Customer-safety report link card (명의 도용 의심 …); a different element from safety-card, the 158px guidance list card
  carousel-indicator:
    type: button
    backgroundColor: '#ffffff'
    rounded: 9999px
    size: 36px x 8px
    shadow: 0 2px 8px rgba(0,0,0,0.1)
    states: default captured 2026-07-12 (the current page's dot); the 2026-09-29 survey reads the other dots at 8px x 8px; no pointer-state sample
    use: Home hero banner page dot ('N페이지 배너 보기')
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    height: 20px
    typography: 16px / 400 / Pretendard
    states: default captured 2026-07-12 (57 links on home, contents and card detail); no pointer-state sample
    use: Footer column link (회사소개, 블로그, 공지사항, 이용약관 …)
fonts:
  roles:
    sans: Pretendard
  faces:
    Pretendard:
      scripts:
        - hangul
        - latin
      evidence:
        - live-surface-use
      source: https://github.com/orioncactus/pretendard
      licence: OFL-1.1
      distribution: public
      note: Banksalad serves its own subsets of the static Pretendard weights.
---

# Banksalad

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Banksalad; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/banksalad/DESIGN.md
