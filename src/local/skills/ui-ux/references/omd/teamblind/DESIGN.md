---
name: Blind
colors:
  primary: '#fb5957'
  on-primary: '#ffffff'
  accent: '#007aff'
  accent-tint: '#f2faff'
  ink: '#222222'
  ink-strong: '#18202a'
  nav: '#5f6b7c'
  nav-hover: '#939dac'
  meta: '#94969b'
  footer-ink: '#42424b'
  canvas: '#ffffff'
  input-border: '#d4d4d4'
  card-border: '#e6e8ef'
  chip-surface: '#f2f2f3'
typography:
  company-hero:
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.25
    use: Hero heading of the company-review hub (h1.tit), white over the hero, Pretendard
  company-section:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    use: Section headings on the company-review hub (h3.ltit), Pretendard
  section:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 2.39
    use: Topic board headings on home (h2.topic, 43px line box, letter-spacing -0.5px), Pretendard
  topic-title:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.35
    use: Channel title on a topic page (h2.topic_is, letter-spacing -0.5px), Pretendard
  post-title-lg:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 1.4
    use: Post titles in the topic-page feed, Pretendard
  company-name:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.4
    use: Company names on featured company cards, Pretendard
  hero-input:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.25
    use: Text in the home hero search field, Pretendard
  nav:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    use: Global navigation (홈, 채널, 기업 리뷰; letter-spacing -0.5px), Pretendard
  post-title:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: Post titles in the home topic boards (a.tit, letter-spacing -0.5px), Pretendard
  preview:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Post preview text in the topic-page feed, Pretendard
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Descriptive copy on the company-review hub (p.desc), Pretendard
  button:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 2.71
    use: 로그인 label (38px line box inside the 40px button, letter-spacing -0.5px), Pretendard
  chip:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.35
    use: Channel chips across the top of a topic page (letter-spacing -0.1px), Pretendard
  meta:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.25
    use: View, comment and like counts and category labels, Pretendard
  footer:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.14
    use: Footer links (letter-spacing -0.2px), Pretendard
rounded:
  none: 0px
  button: 4px
  card: 8px
  search: 20px
  hero-search: 30px
spacing:
  post-row-y: 8
  nav-pad: 4
  card-pad: 20
  action-y: 12
  action-x: 16
  badge-x: 12
components:
  login-button:
    type: button
    backgroundColor: '#fb5957'
    textColor: '#ffffff'
    border: '1px solid #fb5957'
    rounded: 4px
    padding: 0px
    height: 40px
    typography: 14px / 600 / 38px Pretendard, letter-spacing -0.5px
    hover: 'bg #ff928b, border #ff928b'
    pressed: 'bg #ff928b, border #ff928b'
    states: 'hover and pressed frames read #ff928b on all three pages (sibling agreement), the value the page stylesheet authors for .btn_signin:hover and :active, so the frames are the settled end state; focus not measured'
    use: 로그인 at the right of the global header on every captured page, 82 x 40 (read, never followed)
    focus: 'outline #005fcc dotted 1px on :focus-visible'
  header-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #d4d4d4'
    rounded: 20px
    padding: 2px 12px 0px 36px
    height: 40px
    typography: 14px / 400 / 17.5px Pretendard
    states: 'rest only; the pressed frame moved focus into the field, so its #222222 border is a focus reading and no state is declared'
    use: Pill search field in the global header, 248 x 40
  hero-search:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '2px solid #222222'
    rounded: 30px
    padding: 0px 10px 0px 62px
    height: 60px
    typography: 18px / 400 / 22.5px Pretendard
    states: rest only; no pointer or focus frame was recorded for it
    use: Home hero search, 736 x 60, placeholder 관심있는 내용을 검색해보세요!
  gnb-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#5f6b7c'
    padding: 4px
    height: 32px
    typography: 16px / 600 / 24px Pretendard, letter-spacing -0.5px
    selected: 'fg #18202a on the current section (홈 on home, 기업 리뷰 on the company hub)'
    hover: 'fg #939dac'
    pressed: 'fg #939dac'
    states: 'hover and pressed frames read #939dac on every inactive item on all three pages, matching the stylesheet''s #gnb .swiper-slide a:hover rule'
    use: Global navigation 홈, 채널, 기업 리뷰; the fourth slot is an advertising link and is excluded
  more-link:
    type: button
    backgroundColor: transparent
    textColor: '#5f6b7c'
    padding: 0px 20px 0px 8px
    height: 48px
    typography: 12px / 600 / 48px Pretendard, letter-spacing -0.5px
    states: rest on 37 instances; no pointer frame
    use: 더보기 at the right of each home topic board heading, 58 x 48
  post-row:
    type: listItem
    textColor: '#222222'
    padding: 8px 0px
    height: 37px
    typography: 14px / 600 / 21px Pretendard, letter-spacing -0.5px
    use: 'Post title row in the home topic boards; counts beside it in #94969b 12px / 400'
  topic-post:
    type: listItem
    textColor: '#222222'
    typography: 18px / 700 / 25.2px Pretendard
    use: 'Topic-page feed item: 18px bold title, 14px / 400 / 21px preview and 12px #94969b counts, all #222222 except the counts'
  channel-link:
    type: button
    backgroundColor: transparent
    textColor: '#007aff'
    padding: 0px 16px 0px 0px
    height: 46px
    typography: 14px / 600 / 17.99px Pretendard, letter-spacing -0.1px
    states: rest only; no pointer frame
    use: 채널 탐색 link beside the topic title on a topic page
  review-button:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e6e8ef'
    rounded: 8px
    padding: 0px 16px
    height: 40px
    typography: 14px / 600 / 17.5px Pretendard
    states: rest only; no pointer frame
    use: 내 회사 리뷰하기 on the company-review hub, 149 x 40
  category-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #e6e8ef'
    rounded: 8px
    padding: 20px 20px 58px
    size: 173px x 128px
    typography: 14px / 400 / normal Pretendard
    selected: 'bg #f2faff, border 1px solid #007aff'
    use: Selectable cards in the company-review hub (five at rest, one selected); labels not captured
  company-action:
    type: button
    backgroundColor: '#007aff'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 16px
    height: 42px
    typography: 14px / 400 / 17.5px Pretendard
    states: rest on three instances; no pointer frame
    use: Filled blue action at the foot of each of the three featured company cards, 313 x 42; label not captured
  company-badge:
    type: badge
    backgroundColor: '#f2faff'
    textColor: '#222222'
    rounded: 4px
    padding: 8px 12px
    height: 31px
    typography: 12px / 600 / 15px Pretendard
    use: Tinted line on the featured company cards, 313 x 31; label not captured
  app-download-button:
    type: button
    backgroundColor: '#f2f2f3'
    rounded: 20px
    size: 40px x 40px
    states: rest only; no pointer frame
    use: Round App Store and Google Play buttons in the footer
fonts:
  roles:
    sans: Pretendard
---

# Blind

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Blind; reproduced for educational reference. Full prose: https://oh-my-design.kr/teamblind/design.md
