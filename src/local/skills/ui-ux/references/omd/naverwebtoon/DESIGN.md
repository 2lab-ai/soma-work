---
name: Naver Webtoon
colors:
  primary: '#00dc64'
  surface: '#ffffff'
  foreground: '#000000'
  muted: '#666666'
  tag-surface: '#f6f6f6'
  on-primary: '#ffffff'
typography:
  brand-title:
    fontSize: 24px
    fontWeight: 700
    use: Product header wordmark area
  section-title:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.05
    use: Product-home section heading
  tab:
    fontSize: 15px
    fontWeight: 500
    lineHeight: 1.4
    use: Product content tab
  tag:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 2.14
    use: Product-home tag link
rounded:
  square: 0px
  compact: 4px
components:
  content-tab:
    type: tab
    textColor: '#666666'
    typography: 15px / 500 Pretendard
    selected: 'fg #00dc64'
    states: 'rest (aria-selected=false) #666666 and selected (aria-selected=true) #00dc64 captured on all three routes; the seven tab interactions record fg #00dc64 on each newly selected tab; no state frame. Corrected 2026-09-29: fg previously held the selected #00dc64'
    use: Product content tabs, selectors home::[data-omd-capture=16] and home::[data-omd-capture=17]
  tag-link:
    type: badge
    backgroundColor: '#f6f6f6'
    textColor: '#666666'
    rounded: 4px
    padding: 0px 10px
    typography: 14px / 500 Pretendard
    use: Product-home tag link, selector home::[data-omd-capture=64]
  pagination:
    type: button
    textColor: '#000000'
    typography: 14px / 500 Pretendard
    states: 'ten page buttons captured at rest: the first (capture 133) computes fg #00dc64 and the other nine #000000; no aria-current is recorded, so the green is described, not declared as a selected state. The previous control (capture 132) is disabled and computes #000000; it is not read as a rest value. No state frame. Corrected 2026-09-29: fg previously held the first page''s #00dc64'
    use: Best Challenge page buttons (button.Paginate__page, 28 x 28), selector surface-3::[data-omd-capture=134]; the green first page is surface-3::[data-omd-capture=133]
  header-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    padding: 0px 65px 0px 10px
    size: 268px x 35px
    typography: 14px / 400 / Pretendard
    states: default captured on all three routes; no state frame
    use: Product header search field (input.SearchBar__search_input) at home::[data-omd-capture="4"]; the 35 x 35 search button beside it (capture 5) has no fill
  creator-entry:
    type: button
    backgroundColor: '#00dc64'
    textColor: '#000000'
    rounded: 4px
    padding: 11px 33px
    height: 39px
    typography: 12px / 400 / Pretendard
    states: default captured on all three routes; no state frame
    use: Global navigation creator entry (button.GlobalNavigationBar__button_creators) at home::[data-omd-capture="14"], 151 px wide
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
    focus: no visible change (measured 2026-10-16) on :focus-visible
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px 18px
    height: 55px
    typography: 16px / 600 / Pretendard
    selected: 'bg #00dc64, fg #ffffff'
    states: 'six links per route; on each captured route exactly one link computes a #00dc64 fill with #ffffff text, and it moves with the route: the first link on /index (capture 8), the second on /webtoon (capture 9), the fourth on /bestChallenge (capture 11). No aria-current is recorded; the selected value rests on that route-by-route agreement. No state frame'
    use: Product global navigation link (a.GlobalNavigationBar__link) at home::[data-omd-capture="9"]; line height 55px, tracking -0.5px
  sub-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 0px
    padding: 0px 5px
    height: 49px
    typography: 15px / 600 / Pretendard
    states: 'twelve links on /webtoon and eleven on /bestChallenge; on both routes the first link (capture 16) computes fg #00dc64 and the rest #000000. No aria-selected or aria-current is recorded, so the green first link is described, not declared as a selected state; no state frame'
    use: Product sub-navigation link (a.SubNavigationBar__link) at surface-2::[data-omd-capture="17"]; line height 49px, tracking -0.5px
  weekday-heading:
    type: card
    backgroundColor: transparent
    textColor: '#000000'
    size: 169px x 45px
    typography: 14.04px / 700 / Pretendard
    states: 'non-interactive; two headings captured on /webtoon: one computes a #00dc64 fill with #ffffff text, the other transparent with #000000; the capture does not record what the green one marks'
    use: Weekday column heading (h3.WeekdayMainView__heading) at surface-2::h3
  tag-link-large:
    type: badge
    backgroundColor: '#f6f6f6'
    textColor: '#666666'
    rounded: 4px
    padding: 0px 10px
    height: 37px
    typography: 16px / 500 / Pretendard
    states: default captured; no state frame
    use: 'The common size of the TagGroup__tag class at home::[data-omd-capture="130"]: 184 of the 191 home tag links compute 16px / 500 / 37px (tracking -0.42px); the 14px / 30px tag-link covers the other seven'
  qr-code-button:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    border: '1px #ebebeb'
    rounded: 4px
    padding: 0px
    size: 172px x 43px
    typography: 13px / 500 / Pretendard
    states: default captured on home (captures 364-365) and /bestChallenge (captures 210-211); no state frame
    use: Outline QR-code button (button.QrCode__button) at home::[data-omd-capture="364"]; tracking -0.5px
  author-link:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    height: 20px
    typography: 14px / 500 / Pretendard
    states: default captured on all three routes (82 occurrences); no state frame
    use: Author-name link (a.ContentAuthor__author) at home::[data-omd-capture="23"]; line height 20px
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: Pretendard
---

# Naver Webtoon

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Naver Webtoon; reproduced for educational reference. Full prose: https://oh-my-design.kr/naverwebtoon/design.md
