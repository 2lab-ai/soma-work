---
name: Scatter Lab
colors:
  primary: '#fbb401'
  on-primary: '#ffffff'
  ink: '#222222'
  nav-ink: '#212429'
  black: '#000000'
  muted: '#8c8c8c'
  canvas: '#ffffff'
  blog-ink: '#09090b'
  blog-muted: '#646470'
  blog-meta: '#71717a'
  blog-strong: '#020a0f'
  blog-tab-fill: '#f4f4f5'
typography:
  display:
    fontSize: 52px
    fontWeight: 700
    lineHeight: 1.35
    use: Page headline (h1) on the intro and ethos pages
  section:
    fontSize: 38px
    fontWeight: 700
    lineHeight: 1.35
    use: Section heading (h2) on the ethos page
  subhead:
    fontSize: 23px
    fontWeight: 700
    lineHeight: 1.35
    use: Chapter heading (h3) in the intro letter and carousel card titles
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Company-site paragraph and list text
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Footer links on the company site
  blog-hero:
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1
    use: Blog header title (h1), set in white
  blog-feature:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    use: Featured post title (h2) on the blog home
  blog-card-title:
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.375
    use: Post card title (h2) on the blog home
  blog-body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Blog body text
  blog-button:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.43
    use: Blog subscribe button label
rounded:
  sm: 4px
  md: 6px
spacing:
  nav-y: 5.5
  nav-x: 12
  cta-y: 8
  cta-x: 16
  tab-y: 6
  tab-x: 14
components:
  nav-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#212429'
    rounded: 4px
    padding: 5.5px 12px
    height: 32px
    typography: 16px / 400 / normal Pretendard
    states: rest on the intro and ethos pages; no state frame was recorded and the collector expanded no menus
    use: 'Header navigation item (제타 소개, 문화, 블로그, 채용, AI 윤리, English, 日本語) at home::[data-omd-capture="2"], 76 x 32; each sits inside a link whose own colour is #000000'
  blog-header-cta:
    type: button
    backgroundColor: '#fbb401'
    textColor: '#ffffff'
    rounded: 6px
    padding: 8px 16px
    height: 36px
    typography: 16px / 500 / 24px IBM Plex Sans
    shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px
    states: hover and pressed frames match rest in every compared property (the inline background overrides the hover:bg-primary/90 class); the class list also names a hover lift (hover:-translate-y-0.5) that the collector does not measure, so no state is declared
    use: 채용공고 in the blog header, linking to www.scatterlab.co.kr/ko/recruiting, at surface-3::[data-omd-capture="3"], 87 x 36
    pressed: transform matrix(1, 0, 0, 1, 0, -2) (:hover + :active)
    focus: 'shadow #ffffff 0px 0px 0px 0px, #09090b 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px on :focus-visible'
  blog-subscribe-button:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 6px
    padding: 8px 16px
    height: 36px
    typography: 14px / 500 / 20px IBM Plex Sans
    shadow: rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(0, 0, 0, 0.1) 0px 1px 3px 0px, rgba(0, 0, 0, 0.1) 0px 1px 2px -1px
    states: rest only; no state frame was recorded
    use: 구독하기 beside the newsletter field at surface-3::[data-omd-capture="5"], 80 x 36; read without submitting
  blog-email-input:
    type: input
    backgroundColor: transparent
    textColor: '#000000'
    rounded: 6px
    padding: 4px 12px
    height: 36px
    typography: 14px / 400 / 20px IBM Plex Sans
    states: rest captured; the pressed frame adds only zero-width ring layers, a transition frame, so no pressed value is declared; focus is not declared from the capture
    use: Newsletter email field on the blog home at surface-3::[data-omd-capture="4"], 262 x 36; never filled or submitted
  blog-category-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#646470'
    rounded: 6px
    padding: 6px 14px
    height: 36px
    typography: 14px / 500 / 20px IBM Plex Sans
    selected: 'bg #f4f4f5, fg #020a0f, weight 600 (capture 6)'
    states: selected variant read from rest values (capture 6 against 7); no pointer frame
    use: Post-category filter on the blog home at surface-3::[data-omd-capture="7"], 86 x 36, with -0.4px tracking
  blog-icon-button:
    type: button
    backgroundColor: transparent
    textColor: '#020a0f'
    rounded: 6px
    size: 36px x 36px
    states: rest only; no state frame was recorded
    use: Icon-only button at the left of the blog header at surface-3::[data-omd-capture="2"]
  culture-slide-card:
    type: card
    backgroundColor: transparent
    size: 456px x 383px
    use: 'Slide in the intro page''s closing carousel (div.slider__Card); title 23px / 700 / 31.05px #222222, text 16px / 400 / 24px #222222, stepped by 40 x 40 arrow buttons'
fonts:
  roles:
    sans: Pretendard
    blog: IBM Plex Sans
---

# Scatter Lab

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Scatter Lab; reproduced for educational reference. Full prose: https://oh-my-design.kr/scatterlab/design.md
