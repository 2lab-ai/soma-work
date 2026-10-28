---
name: Classum
colors:
  primary: '#ff4438'
  canvas: '#f6f6f9'
  surface: '#ffffff'
  ink: '#232334'
  body: '#333333'
  muted: '#666b80'
  on-primary: '#ffffff'
typography:
  marketing-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Repeated public-marketing text/card sample
  marketing-heading:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.4
    use: Public-marketing H1/H2 sample
  action:
    fontSize: 15px
    fontWeight: 600
    lineHeight: 1.5
    use: Repeated public-marketing navigation action
rounded:
  control: 8px
  card-item: 12px
  card: 30px
spacing:
  xs: 6
  sm: 8
  md: 16
  card: 30
components:
  nav-primary-action:
    type: button
    backgroundColor: '#ff4438'
    textColor: '#ffffff'
    rounded: 8px
    padding: 6px 16px
    typography: 15px / 600 Pretendard Variable
    states: default only; no interaction state captured
    use: Public marketing navigation CTA; home::[data-omd-capture=4]
    height: 35px
    pressed: background-image linear-gradient(rgba(0, 0, 0, 0.2), rgba(0, 0, 0, 0.2)) (:hover + :active)
  nav-outline-light:
    type: button
    textColor: '#ff4438'
    border: '1px solid #ff4438'
    rounded: 8px
    padding: 6px 16px
    typography: 15px / 600 Pretendard Variable
    states: default only; no interaction state captured
    use: Public marketing light-background navigation outline; home::[data-omd-capture=3]
  nav-outline-dark:
    type: button
    textColor: '#ffffff'
    border: '1px solid #ffffff'
    rounded: 8px
    padding: 6px 16px
    typography: 15px / 600 Pretendard Variable
    states: default only; no interaction state captured
    use: Public marketing dark-background navigation outline; home::[data-omd-capture=8]
  large-primary-action:
    type: button
    backgroundColor: '#ff4438'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 34px
    typography: 18px / 600 Pretendard Variable
    states: default only; no interaction state captured
    use: Public marketing large CTA on home and learning routes; home::[data-omd-capture=17]
  university-grid-card:
    type: card
    backgroundColor: '#f6f6f9'
    textColor: '#333333'
    rounded: 30px
    padding: 30px
    typography: 14px / 400 Pretendard Variable
    states: default only; no interaction state captured
    use: University-LMS public-marketing grid card; university-lms::div.grid-card
  nav-link:
    type: tab
    backgroundColor: transparent
    textColor: '#232334'
    rounded: 0px
    padding: 0px 18px
    height: 64px
    typography: 15px / 600 Pretendard Variable
    states: 'rest captured on all three routes: six light-header copies (class on-white) and six dark-header copies; no state frame in the bundle'
    use: 'Header navigation link (a.nav-link.on-white), home::[data-omd-capture="1"]; line height 22.5px, tracking -0.6px. The dark-header copy (a.nav-link, home captures 6 and 7) computes fg #ffffff with the same geometry and type'
  medium-primary-action:
    type: button
    backgroundColor: '#ff4438'
    textColor: '#ffffff'
    rounded: 8px
    padding: 8px 24px
    height: 49px
    typography: 16px / 600 Pretendard Variable
    states: one captured at rest in the home hero; no state frame in the bundle
    use: Home hero primary action (a.primary-button.medium), home::[data-omd-capture="11"]; line height 24px
  white-action:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#232334'
    rounded: 8px
    padding: 12px 34px
    height: 51px
    typography: 18px / 600 Pretendard Variable
    states: 'captured at rest in three sizes: large (home capture 16), medium (home capture 10: 8px 24px, 49px, 16px / 600) and small (learning capture 10: 8px 16px, 43px, 18px / 600); no state frame in the bundle'
    use: White action on dark sections (a.primary-button.white-button), home::[data-omd-capture="16"]; line height 27px
  black-action:
    type: button
    backgroundColor: '#232334'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 34px
    height: 51px
    typography: 18px / 600 Pretendard Variable
    states: one captured at rest on learning; no state frame in the bundle
    use: Dark action (a.primary-button.large.black-button) on the learning route, surface-2::[data-omd-capture="12"]; line height 27px
  gray-action:
    type: button
    backgroundColor: '#dadeea'
    textColor: '#272730'
    rounded: 8px
    padding: 0px 36px
    height: 49px
    typography: 18px / 600 Pretendard Variable
    states: one captured at rest on university-lms; no state frame in the bundle
    use: 'Grey action (a.primary-button.gray-button) in the university-LMS hero, surface-3::[data-omd-capture="10"]; it sits beside a #ff4438 action with the same padding and height (capture 11)'
  sitemap-link:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px
    height: 29px
    typography: 18px / 600 Pretendard Variable
    states: ten per route captured at rest on all three routes (30 in all); no state frame in the bundle
    use: Footer sitemap link (a.sitemap-link) on the dark footer, home::[data-omd-capture="19"]; line height 28.8px
  copyright-link:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px
    height: 18px
    typography: 12px / 300 Pretendard Variable
    states: two per route captured at rest on all three routes; no state frame in the bundle
    use: Footer legal link (class copryright-link, as spelled in the markup), home::[data-omd-capture="29"]; line height 18px
  feature-card:
    type: card
    backgroundColor: '#dadeec'
    rounded: 12px
    padding: 0px
    size: 563px x 456px
    states: 'four captured at rest on home (captures 12-15). The bundle holds 10 frames on them (hover and pressed on all four, focus on 14 and 15); none records a settled change: hover moves box-shadow from none to an alpha-0 colour, pressed to an alpha-0.004 colour, and focus is not declared from bundles'
    use: 'Home feature card (a.feat-item), home::[data-omd-capture="12"]. The anchor computes Chromium default link colour #0000ee and the 14px / 400 body type, which is container text, so no label style is declared'
  comparison-table-row:
    type: card
    backgroundColor: transparent
    textColor: '#666b80'
    border: '0px 0px 2px #333333'
    padding: 15px 0px
    height: 67px
    typography: 22px / 400 Pretendard Variable
    states: 18 rows captured at rest on university-lms; no state frame in the bundle
    use: 'Comparison table row (div.table-line) on university-lms, surface-3::div; the 2px #333333 border is on the bottom edge only; text colour and font are the row heading child (div.table-row-heading, line height 35.2px)'
fonts:
  roles:
    ui: Pretendard Variable
---

# Classum

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Classum; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/classum/DESIGN.md
