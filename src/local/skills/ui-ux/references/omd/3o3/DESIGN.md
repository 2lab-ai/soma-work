---
name: 3o3
colors:
  primary: '#fbbd41'
  on-primary: '#000000'
  action-hover: '#237af2'
  action-blue: '#3e79ff'
  slate: '#2f3943'
  canvas: '#ffffff'
  ink: '#000000'
  blog-ink: '#15171a'
  heading: '#2b2f34'
  body-sub: '#606a76'
  muted: '#788391'
  faint: '#a4acb4'
  tag-grey: '#979797'
  selected: '#141618'
  surface: '#f5f6f8'
  tint-blue: '#f3f8ff'
  outline: '#dadee3'
  placeholder: '#f1f1f1'
typography:
  featured-title:
    fontSize: 33px
    fontWeight: 700
    lineHeight: 1.5
    use: White post titles over the blog's lead slider (h2.post-card-title, 792px slides); declared Noto Sans KR stack
  card-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Post titles on the blog''s 380px cards, #2b2f34'
  card-title-sm:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.4
    use: 'Post titles on the blog''s 240px cards, #2b2f34'
  cta:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.22
    use: Call-to-action labels on the homepage, Noto Sans KR
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: 'Blog body text, #15171a'
  excerpt:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Post excerpts on blog cards (div.post-card-excerpt), #788391'
  nav:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: 'Blog header links (테크, 컬처, 뉴스룸, 라이브러리), #606a76; the computed stack is Poppins, sans-serif, but the labels are Korean, which Poppins does not cover, so they render in the fallback face'
  disclosure:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: 'Paragraph copy and the disclosure block on the homepage, Noto Sans KR, #000000'
  tag:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.5
    use: Topic-filter button labels on the blog (button.btn-tag)
  chip:
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1
    letterSpacing: '-0.07px'
    use: Category chip labels on blog cards (span.post-card-primary-tag)
  tag-list:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-0.07px'
    use: 'Tag line above blog post titles (div.post-card-tags), #979797'
rounded:
  cta: 7px
  image-sm: 16px
  image: 24px
  tag: 24px
  chip: 36px
  pill: 100px
spacing:
  tag-y: 11
  tag-x: 20
  chip-y: 5
  chip-x: 10
  more-y: 16
  more-x: 32
components:
  refund-cta:
    type: button
    backgroundColor: '#fbbd41'
    textColor: '#000000'
    rounded: 7px
    height: 61px
    width: 361px
    typography: 18px / 500 / 22px Noto Sans KR
    hover: 'bg #237af2, fg #ffffff'
    pressed: 'bg #e29929, fg #000000'
    states: 'hover and pressed read from settled frames: the hover frame of every homepage action reads the same #237af2 fill with white text (sibling agreement across captures 0-4) and equals the page''s own #lp-pom-button :hover rules; the pressed frames equal its :active rules; focus is not declared, because the collector''s focus frames only repeat the pressed values'
    use: Primary refund action, three of the five homepage calls-to-action (내 환급금 조회하기 at home::[data-omd-capture="1"], 지금 찾으러 가기, 지금 환급 신청하기), 361 x 61, each linking to app.3o3.co.kr
    padding: 0px
    focus: no visible change (measured 2026-10-16) on :focus-visible
  eligibility-cta:
    type: button
    backgroundColor: '#2f3943'
    textColor: '#ffffff'
    rounded: 7px
    height: 61px
    width: 361px
    typography: 18px / 500 / 22px Noto Sans KR
    hover: 'bg #237af2, fg #ffffff'
    pressed: 'bg #1e2c3c, fg #ffffff'
    states: hover and pressed from settled frames that equal the page's own :hover and :active rules; focus not declared
    use: 대상자 여부 확인하기 on the homepage at home::[data-omd-capture="2"], 361 x 61
  secure-cta:
    type: button
    backgroundColor: '#3e79ff'
    textColor: '#ffffff'
    rounded: 7px
    height: 61px
    width: 361px
    typography: 18px / 500 / 22px Noto Sans KR
    hover: 'bg #237af2, fg #ffffff'
    pressed: 'bg #2756e6, fg #ffffff'
    states: hover and pressed from settled frames that equal the page's own :hover and :active rules; focus not declared
    use: 안전하게 환급 신청하기 on the homepage at home::[data-omd-capture="4"], 361 x 61
  topic-filter:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#606a76'
    border: '1px solid #dadee3'
    rounded: 24px
    padding: 11px 20px
    height: 45px
    typography: 14px / 700 / 21px
    selected: 'bg #141618, fg #ffffff, border 1px solid #dadee3 (button.btn-tag.active, capture 29)'
    states: selected variant read from rest values (capture 29 against capture 30 and its seven siblings); no pointer frame was recorded
    use: Topic filter buttons above the blog's post list (button.btn-tag) at surface-3::[data-omd-capture="30"], 66 x 45
  category-chip:
    type: badge
    backgroundColor: '#f3f8ff'
    textColor: '#2f3943'
    rounded: 36px
    padding: 5px 10px
    height: 24px
    typography: 14px / 700 / 14px, letter-spacing -0.07px
    use: Primary-tag chip on the blog's 380px post cards (span.post-card-primary-tag), 56 x 24
  category-chip-grey:
    type: badge
    backgroundColor: '#f5f6f8'
    textColor: '#2f3943'
    rounded: 77px
    padding: 4px 12px
    height: 22px
    typography: 14px / 700 / 14px, letter-spacing -0.07px
    use: Primary-tag chip on the blog's 240px cards, 84 x 22; the featured slider uses the same fill at 13px / 700 with 3px 9px padding, 30px tall, 49px radius
  post-card:
    type: card
    backgroundColor: transparent
    textColor: '#2b2f34'
    rounded: 24px
    use: 'Blog post card: image (img.post-card-image) on a #f1f1f1 placeholder fill with a 24px radius at 380px and 792px wide and 16px at 240px wide, then tag line #979797, title #2b2f34, excerpt #788391 and meta #a4acb4; no border or shadow'
  load-more:
    type: button
    backgroundColor: '#f5f6f8'
    textColor: '#15171a'
    rounded: 100px
    padding: 16px 32px
    height: 56px
    typography: 16px / 400 / 25.6px
    states: rest only; no state frame was recorded
    use: Pill button below the blog's post list at surface-3::[data-omd-capture="62"], 256 x 56; its label sits in a child that was not captured
fonts:
  roles:
    funnel: Noto Sans KR
---

# 3o3

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 3o3; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/3o3/DESIGN.md
