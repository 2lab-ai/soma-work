---
name: Wanted
colors:
  primary: '#0066ff'
  canvas: '#ffffff'
  heading: '#171719'
  body: '#333333'
  secondary: '#858688'
  subtle-surface: '#f8f8f8'
  hairline: '#e8e9ea'
  on-primary: '#ffffff'
typography:
  heading:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.36
    letterSpacing: '-0.4268px'
    use: Current product section headings and Montage headings
  subtitle:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0.0912px
    use: Job-card position title
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Product lists, cards, actions, and supporting copy
  caption:
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: 0.3024px
    use: Job-card industry and metadata
rounded:
  control: 8px
  card: 12px
  menu: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 14
  lg: 20
  xl: 40
components:
  header-action:
    type: button
    backgroundColor: transparent
    textColor: '#0066ff'
    rounded: 8px
    padding: 7px 14px
    height: 32px
    typography: 14px / 400 (the button's computed style; the visible label span's type was not read)
    shadow: rgba(112,115,124,0.16) 0 0 0 1px inset
    hover: 'overlay layer #171719 opacity 0 → 0.0375'
    pressed: 'overlay layer #171719 opacity 0.09'
    focus: 'outline #0066ff auto 1px, offset 0px (auto-style ring drawn in an authored colour) — measured 2026-09-29'
    states: 'default captured 2026-07-12; hover and pressed measured 2026-09-29 on the empty state-layer child div.wds-bi8qpk (bg #171719, opacity 0 at rest); keyboard focus measured 2026-09-29 (Tab 11)'
    use: Current product header account action
  filter-button:
    type: button
    backgroundColor: transparent
    textColor: '#171719'
    rounded: 8px
    padding: 7px 11px
    height: 36px
    typography: 15px / 500 / Pretendard Variable (label span; the button computes 14px / 400)
    shadow: rgba(112,115,124,0.16) 0 0 0 1px inset
    hover: 'overlay layer #171719 opacity 0 → 0.0375'
    pressed: 'overlay layer #171719 opacity 0.09'
    focus: 'outline 2px #0066ff, offset -2px, drawn inside the box (authored) — measured 2026-09-29'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 (Tab 19); no selected value inferred; rest transition background-color, color, box-shadow 0.3s
    use: All-tags and filter trigger on the job directory
  mini-job-card:
    type: card
    backgroundColor: transparent
    rounded: 12px image
    gap: 14px
    typography: 16px / 600 title
    hover: transform scale(1.025) on the media; the card's bookmark button goes visibility hidden → visible
    pressed: 'same as hover: transform scale(1.025) on the media, bookmark button visible'
    focus: 'outline #0066ff auto 1px, offset 1px (auto-style ring in an authored colour) — measured 2026-09-29'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the first of 36 cards (Tab 83); the bookmark reveal was read by the fixed probe tool, which compares every descendant including visibility
    use: Horizontal recommended-job card on the current home surface
  job-card:
    type: card
    backgroundColor: transparent
    rounded: 12px thumbnail
    bodyPadding: 0px 6px
    gap: 2px
    typography: 16px / 600 position title
    hover: transform scale(1.025) on the thumbnail image (308px → 315.7px wide)
    pressed: transform scale(1.025) on the thumbnail image (same as hover)
    focus: 'no visible indication: outline none and no other compared property changes on the link, its 12 descendants or 2 ancestors (measured 2026-09-29)'
    states: default captured 2026-07-12; hover, pressed and keyboard focus measured 2026-09-29 on the first of 20 cards (Tab 39), confirmed by a script that reads every descendant
    use: Vertical job result card on the current directory
  search-dialog:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#171719'
    inputFont: 16px / 400 / 24px
    states: dialog-open captured on four product surfaces
    use: Full-screen product search input revealed from the header
  montage-menu:
    type: dialog
    backgroundColor: transparent
    rounded: 16px
    gap: 4px
    shadow: 0 2px 4px -2px rgba(23,23,23,0.06), 0 4px 6px -1px rgba(23,23,23,0.06)
    states: dialog-open captured on Montage pages
    use: Compact current Montage navigation/menu overlay
  explore-cta:
    type: button
    backgroundColor: '#0066ff'
    textColor: '#ffffff'
    rounded: 12px
    padding: 12px 28px
    height: 48px
    typography: 16px / 600 / Pretendard Variable (label span; the link computes 14px / 400)
    hover: 'overlay layer #171719 opacity 0 → 0.075'
    pressed: 'overlay layer #171719 opacity 0.18'
    focus: 'outline 2px #0066ff, offset 1px (authored, not the browser ring) — measured 2026-09-29'
    states: rest, hover, pressed and keyboard focus measured 2026-09-29 (Tab 160); hover and pressed read on the empty state-layer child div.wds-bi8qpk; not in the 2026-07-12 capture
    use: Filled primary CTA 탐색하기 (link to /wdlist) at the bottom of the current home
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#171719'
    height: 60px
    typography: 15px / 600 / Pretendard Variable, 0.144px tracking
    hover: no visible change (measured 2026-09-29)
    pressed: no visible change (measured 2026-09-29)
    focus: 'outline #0066ff auto 1px, offset 3px, on the label span (auto-style ring in an authored colour) — measured 2026-09-29'
    states: default captured 2026-07-12 on the header of home, jobs and company; hover, pressed and keyboard focus measured 2026-09-29 on 채용 (Tab 2); the link declares transition color 0.2s yet shows no visible change
    use: Global header navigation link (채용, 이력서, 교육•이벤트 …)
  header-secondary-button:
    type: button
    backgroundColor: transparent
    rounded: 8px
    padding: 7px 14px
    height: 32px
    shadow: rgba(112,115,124,0.16) 0 0 0 1px inset
    states: default captured 2026-07-12 on the home, jobs and company headers; no state was read; the label was not captured, so no text colour or type is declared
    use: Header employer-service button 기업 서비스 beside the account action
  tag-chip:
    type: button
    backgroundColor: transparent
    rounded: 10px
    padding: 7px 9px 7px 11px
    height: 36px
    shadow: rgba(112,115,124,0.16) 0 0 0 1px inset
    states: default captured 2026-07-12 (three chips on the jobs directory); no state sample; the label was not captured, so no text colour or type is declared
    use: Job-directory tag chip beside the 태그 전체 trigger
  company-outline-button:
    type: button
    backgroundColor: transparent
    rounded: 12px
    padding: 12px 28px
    height: 48px
    shadow: rgba(112,115,124,0.16) 0 0 0 1px inset
    states: default captured 2026-07-12 on /company; no state sample; the label was not captured, so no text colour or type is declared
    use: Large outline button on the company service page; same height, radius and padding as the filled explore CTA
  bookmark-button:
    type: button
    backgroundColor: transparent
    rounded: 50%
    padding: 8px
    size: 40px x 40px
    states: default captured 2026-07-12 (one in each of the 20 job cards); not state-read on 2026-09-29, when hovering the card left its own state layer unchanged
    use: Bookmark icon button nested in each directory job card (24px icon)
fonts:
  roles:
    ui: Pretendard Variable
---

# Wanted

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Wanted; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/wanted/DESIGN.md
