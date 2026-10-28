---
name: Remember
colors:
  action-black: '#000000'
  surface: '#ffffff'
  foreground: '#222222'
  input-surface: '#f2f2f2'
  muted: '#808080'
  hairline: '#d4d4d4'
  corporate-orange: '#fc5d11'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.45
    use: Repeated career posting text and controls
  heading:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.3
    use: Career posting section heading
  card-title:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.45
    use: Career posting card title
rounded:
  sm: 4px
  md: 6px
  lg: 8px
spacing:
  xs: 4
  sm: 8
  md: 12
  lg: 16
  xl: 24
components:
  career-outline-dialog-button:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 6px
    padding: 0px 12px
    typography: 14px/400 Pretendard
    hover: 'overlay layer opacity 0 → 0.1 (::before #ffffff over the transparent button on the #000000 header: it lightens the button by compositing arithmetic; not pixel-checked)'
    pressed: 'overlay layer opacity 0 → 0.2 (the same #ffffff layer; it lightens the button by arithmetic; not pixel-checked)'
    focus: 'outline 2px #000000, offset 2px (authored ring); black on the black header, so its visibility is doubtful by arithmetic — measured 2026-09-29, not pixel-checked'
    states: dialog-open observed from this trigger 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 (Tab 10); the probe never clicks, so the dialog was not re-opened; aria-expanded false at rest
    use: Career postings header control at career-postings::[data-omd-capture=10]
  career-job-list-item:
    type: listItem
    textColor: '#222222'
    rounded: 0px
    typography: 16px/400 Pretendard
    hover: no change in the compared scope (the card link, its ::before/::after, 18 descendants incl. 1 svg, 1 path and 1 img, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (same scope as hover) — measured 2026-09-29
    focus: no focus indication in the compared scope (same scope as hover) — measured 2026-09-29
    states: 'default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on the link inside the first curated posting item (Tab 75, second load); its title label is 16px / 600 #000000'
    use: Chromeless job-list item at career-postings::li; 162px-wide representative capture
  filled-auth-control:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px
    size: 36px x 32px
    typography: 14px / 400 / Pretendard
    hover: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 로그인 (Tab 8), logged out and never activated; transition all 0s
    use: Career header 로그인 control
    height: 32px
  white-header-control:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 6px
    padding: 0px 12px
    size: 72px x 32px
    typography: 14px / 400 / Pretendard
    hover: 'overlay layer opacity 0 → 0.1 (::before #ffffff over the #ffffff fill: invisible by compositing arithmetic; not pixel-checked)'
    pressed: 'overlay layer opacity 0 → 0.2 (the same #ffffff layer: invisible by compositing arithmetic; not pixel-checked)'
    focus: 'outline 2px #000000, offset 2px (authored ring) — measured 2026-09-29'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 회원가입 (Tab 9), never activated; the ::before layer is full-size
    use: Career header 회원가입 control
  search-input:
    type: input
    backgroundColor: '#f2f2f2'
    textColor: '#808080'
    rounded: 4px
    padding: 0px 0px 0px 56px
    size: 817px x 52px
    typography: 16px / 400 / Pretendard
    hover: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 0 descendants, 3 ancestor levels) — measured 2026-09-29
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 (Tab 25); nothing was typed; the placeholder colour was not read separately
    use: Career search field (직무, 회사를 검색해 주세요)
  filter-control:
    type: button
    backgroundColor: transparent
    textColor: '#000000'
    border: '1px solid #d4d4d4'
    rounded: 4px
    padding: 10px 16px
    size: 82px x 42px
    typography: '14px / 400 / Pretendard (visible label; the button itself computes #222222 16px / 400)'
    hover: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    pressed: no change in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    focus: no focus indication in the compared scope (self, its ::before/::after, 4 descendants incl. 1 svg and 1 path, 3 ancestor levels) — measured 2026-09-29
    states: six controls captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 직무 only (Tab 153); 연봉 and 지역 share its class
    use: Career posting filter button (직무, 연봉, 지역 and three more)
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    padding: 4px 8px 0px
    size: 71px x 60px
    typography: 16px / 600 / Pretendard
    selected: '::after bg #ff6a0d, a 2px bar under the current section link; unchanged in every state'
    hover: 'fg #808080'
    pressed: 'fg #808080'
    focus: 'fg #808080 (text colour only, no outline) — measured 2026-09-29'
    states: 'default, hover, pressed and keyboard focus measured 2026-09-29 on 채용공고 (Tab 2); transition color 0.1s; the July hover, pressed and focus frames on these links (#f8f8f8, #e7e7e7, #dcdcdc and others) are mid-transition greys on the way to #808080 and are not used'
    use: Career header product link (채용공고 and its siblings) on the black header
  search-submit:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 6px
    padding: 0px 12px
    size: 116px x 52px
    typography: '18px / 400 / Pretendard (visible label; the button itself computes #000000 14px / 400)'
    hover: 'overlay layer opacity 0 → 0.1 (::before #000000 over the #000000 fill: invisible by compositing arithmetic; not pixel-checked)'
    pressed: 'overlay layer opacity 0 → 0.2 (the same #000000 layer: invisible by compositing arithmetic; not pixel-checked)'
    focus: 'outline 2px #000000, offset 2px (authored ring) — measured 2026-09-29'
    states: default captured 2026-07-13; hover, pressed and keyboard focus measured 2026-09-29 on 검색 (Tab 26), never submitted
    use: Career search submit (검색) beside the search field
  career-header-dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 4px
    padding: 8px 0px
    size: 170px x 280px
    typography: 16px / 400 / Pretendard (menu links 170px x 44px, padding 0px 12px)
    shadow: rgba(0,0,0,0.1) 0px 4px 12px 0px
    states: open state captured 2026-07-13 after the 기업 서비스 trigger (dialog-open); the 2026-09-29 probe never clicks, so it was not re-opened
    use: Menu dialog opened from the career header 기업 서비스 control
  career-card-icon-button:
    type: button
    backgroundColor: transparent
    textColor: '#222222'
    padding: 7px
    size: 38px x 41px
    states: default captured 2026-07-13; no text node; not probed
    use: Icon-only button at the top edge of each career posting card; the probe report treats the posting card bookmark control as login-gated, and this button was not probed
  corporate-footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#4c4e52'
    typography: 12px / 400, line height 24px
    hover: 'fg #999999'
    pressed: 'fg #999999'
    states: default, hover and pressed captured 2026-07-13 on four footer links, identical in both states on all four, so settled rather than mid-transition; keyboard focus not measured
    use: Corporate site (corp.remember.co.kr) footer text link; marketing domain only
fonts:
  roles:
    ui: Pretendard
---

# Remember

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Remember; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/remember/DESIGN.md
