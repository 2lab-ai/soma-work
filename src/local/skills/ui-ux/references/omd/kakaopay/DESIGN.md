---
name: KakaoPay
colors:
  primary: '#ffeb00'
  ink: '#060b11'
  title: '#191c20'
  text: '#000000'
  canvas: '#ffffff'
  band: '#eff2f4'
  timeline-text: '#dfdfdf'
  on-dark: '#f2f2f2'
  pill-border: '#606a74'
  control-border: '#d2d2d2'
typography:
  hero:
    fontSize: 63px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: 0px
    use: 'Home hero title (마음놓고 금융하다) in #ffffff over the hero video, 72.45px line'
  display:
    fontSize: 52px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: 0px
    use: 'Brand-page closing headline (안심하고 사용할 수 있습니다) in #060b11, 67.6px line'
  section:
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.39
    letterSpacing: '-0.4px'
    use: 'Section titles on the payment page (이렇게 쓰세요, 함께하면 좋아요) in #191c20, 50.04px line'
  statement:
    fontSize: 31.5px
    fontWeight: 500
    lineHeight: 1.39
    letterSpacing: '-0.4px'
    use: 'Two-line feature statements down the home page (일상의 모든 금융 / 한 번에 관리해요) in #060b11, 43.785px line'
  brand-headline:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: 0px
    use: 'Brand-page opening headline block (카카오페이, 새로운 금융을 만들고 있어요) in #000000, 32.2px line'
  card-title:
    fontSize: 26px
    fontWeight: 500
    lineHeight: 1.46
    letterSpacing: '-0.4px'
    use: 'Service-card title on the payment page in #060b11, 37.96px line'
  timeline:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.46
    letterSpacing: '-0.2px'
    use: 'Brand-page history timeline entries in #dfdfdf, 26.28px line'
  button-large:
    fontSize: 18px
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: '-0.2px'
    use: 'App-store pill labels on the home hero in #f2f2f2, 20.7px line'
  nav:
    fontSize: 16px
    fontWeight: 300
    lineHeight: 5.25
    letterSpacing: 0px
    use: 'Header menu links (카카오페이, 서비스, 소식, ESG …) in #060b11, set on an 84px line that is the header height; weight 500 marks the current section'
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: 0px
    use: 'Document default on all four pages, 16.1px line, in #000000'
rounded:
  none: 0px
  control: 4px
  marker: 8px
  pill: 9999px
spacing:
  control: 8
  pill-x: 22
  card: 40
  band-y: 76
components:
  app-store-pill:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.2)
    textColor: '#f2f2f2'
    border: '1px solid #606a74'
    rounded: 9999px
    padding: 0px 22px
    height: 56px
    typography: 18px / 500 / 20.7px Noto Sans KR, letter-spacing -0.2px
    states: 'rest only: the bundle holds no hover, pressed or focus frame for this control, so those states are unmeasured'
    use: iOS 앱스토어로 이동 and 안드로이드 구글플레이로 이동 links over the home hero video, 163 x 56 and 170 x 56 (home::[data-omd-capture="11"])
  media-control:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.2)
    textColor: '#f2f2f2'
    border: '1px solid #d2d2d2'
    rounded: 9999px
    padding: 8px
    size: 40px x 40px
    states: rest only; no state frame was recorded
    use: Round icon buttons over the home hero video (자막 켜기, 일시정지, 소리 켜기, 전체화면 켜기), home::[data-omd-capture="13"] and its three siblings
  icon-circle:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#060b11'
    border: 1px solid rgba(6, 11, 17, 0.56)
    rounded: 9999px
    padding: 8px
    size: 40px x 40px
    use: Outline arrow circle in the corner of each payment-page service card (Circle-module outline); the same white outline circle is used for the arrow buttons of the home feature sections
  slide-control:
    type: button
    textColor: '#000000'
    rounded: 4px
    size: 32px x 32px
    hover: bg rgba(6, 11, 17, 0.06)
    pressed: bg rgba(6, 11, 17, 0.06)
    states: rest is transparent; the hover and pressed frames lay a 6% ink tint over the square and change nothing else in the recorded properties; no focus frame was recorded
    use: 이전 / 정지 / 다음 controls of the merchant logo carousels (온라인, 오프라인) on the payment page, surface-3::[data-omd-capture="13"] to "18"
  nav-link:
    type: tab
    textColor: '#060b11'
    typography: 16px / 300 / 84px Noto Sans KR
    selected: weight 500 on the current section (서비스 on the payment page, class noHover)
    hover: 'weight 300 to 500; on home the label also changes from #ffffff to #060b11'
    pressed: weight 500, as hover
    focus: 'on home the label turns #060b11 and stays at weight 300; no outline value is recorded in the frame'
    states: 'rest, hover, pressed and focus frames on the seven header links of home and the brand page; over the home hero the rest label is #ffffff'
    use: Header menu links on every kakaopay.com page (surface-3::[data-omd-capture="1"] to "7")
  disclosure-tab:
    type: tab
    textColor: '#000000'
    typography: 14px / 400 / 16.1px Noto Sans KR
    height: 30px
    selected: aria-selected=true on the fourth tab with the same recorded colour, weight and background as the other three
    states: role=tab; the bundle records no computed difference between the selected and unselected tabs in the dumped properties
    use: Sub-menu tabs of the product-disclosure page (surface-4::[data-omd-capture="13"] to "16")
  service-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    padding: 40px
    size: 554px x 392px
    use: 'Linked service cards (결제할 때 바로 포인트 적립해드려요, 가스, 전기, 통신요금도 카톡에서 납부하세요) laid in pairs on the #eff2f4 band at the foot of the payment page (surface-3::[data-omd-capture="19"], "20")'
fonts:
  roles:
    sans: Noto Sans KR
---

# KakaoPay

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KakaoPay; reproduced for educational reference. Full prose: https://oh-my-design.kr/kakaopay/design.md
