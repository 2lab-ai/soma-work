---
name: MEGABOX
colors:
  primary: '#503396'
  canvas: '#ffffff'
  foreground: '#444444'
  muted: '#666666'
  on-primary: '#ffffff'
typography:
  body:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 22.5px
    use: Observed on the supplied public home, movie, and booking routes; no native or authenticated-app scope is claimed.
  section-title:
    fontSize: 27.999px
    fontWeight: 400
    lineHeight: 30.7989px
    letterSpacing: '-1px'
    use: Observed only on the supplied public movie-route h2.
rounded:
  compact-control: 4px
  theater-lookup: 30px
spacing:
  like-button-inline: 5
  search-input-inline: 10
components:
  movie-like-button:
    type: button
    backgroundColor: '#ffffff'
    text: '#503396'
    border: '1px solid #ebebeb'
    rounded: 4px
    padding: 0px 5px
    height: 36px
    typography: 13.0005px / 400 / NanumBarunGothic
    states: rest on 20 like buttons on the movie route (surface-2 capture 29 and siblings); the bundle holds no state frame for any MEGABOX element
    use: Movie route list action at surface-2::[data-omd-capture="29"].
    pressed: 'bg #f2f4f8, label #351f67, outline #000000 dotted 1px (+2 nested-layer changes) (:hover + :active)'
    focus: 'outline #000000 dotted 1px on :focus-visible'
  movie-like-button-on-dark:
    type: button
    backgroundColor: rgba(0, 0, 0, 0.4)
    textColor: '#ffffff'
    border: '1px #555555'
    rounded: 4px
    padding: 0px 5px
    size: 80px x 36px
    typography: 13.0005px / 400 / 34px NanumBarunGothic, tracking -0.5px
    states: rest on four home buttons (home capture 29, 32, 35, 38); no state frame
    use: Home like button (button.button.btn-like, the movie-route class) at home::[data-omd-capture="29"], under each home movie poster; translucent black fill
  booking-button:
    type: button
    backgroundColor: '#503396'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px
    size: 153px x 36px
    typography: 15px / 400 / 36px NanumBarunGothic
    states: rest on the movie-route booking links; no state frame
    use: Booking link (a.button.purple.bokdBtn; an a element with no button role) at surface-2::[data-omd-capture="35"], one per movie card beside the like button; it narrows to 74px x 36px where an icon-only a.button.purple.img.splBtn (capture 31, no text) sits beside it (capture 30, 39)
  home-teal-button:
    type: button
    backgroundColor: '#037b94'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0px
    size: 160px x 36px
    typography: 15px / 400 / 36px NanumBarunGothic
    states: rest on four home links (home capture 30, 33, 36, 39); no state frame
    use: Link (a.button.gblue; no button role) beside each home like button at home::[data-omd-capture="30"]; a larger a.button.gblue (capture 58, 145px x 50px, 19.9995px / 400 / 48px) sits further down the home
  outline-link-on-dark:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 4px
    padding: 0px
    size: 145px x 50px
    typography: 19.9995px / 400 / 48px NanumBarunGothic
    states: rest; one instance; no state frame
    use: White outline link (a.button; no button role) at home::[data-omd-capture="57"], beside the larger teal link (capture 58) below white 36px / 400 title text (p.tit); the fill behind them is not in the capture
  movie-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px #ebebeb on top and 1px #503396 at the bottom of the parent li; 1px #ebebeb side dividers on some'
    size: 220px x 41px
    typography: 16.0005px / 400 / 40px NanumBarunGothic
    selected: 'bg #ffffff, fg #503396; parent li border 1px #503396 on the top and sides, 0px at the bottom'
    states: rest on four tabs (surface-2 capture 20-23); the tab whose li has class on (capture 19) differs from them and is recorded as selected; no state frame
    use: Movie-route tab label (a) in div.tab-list.fixed at surface-2::[data-omd-capture="20"]; the borders sit on the parent li (220px x 42px)
  movie-search-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#444444'
    padding: 0px 10px
    size: 197px x 34px
    typography: 15px / 400 / 30px NanumBarunGothic
    states: rest, empty (textLength 0); no state frame
    use: 'Movie-route search field (input.input-text) at surface-2::[data-omd-capture="25"]; the input records no border of its own; its 30px x 32px search button (capture 26) has 0px type; the home input.input-text (capture 40) is transparent with #ffffff text, 170px x 29px'
  list-more-button:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    border: '1px #eaeaea'
    rounded: 0px
    padding: 0px
    size: 1100px x 40px
    typography: 15px / 400 / 17.25px NanumBarunGothic, tracking -0.5px
    states: rest; no state frame
    use: Full-width button (button.btn) below the movie list at surface-2::[data-omd-capture="109"]
  gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#444444'
    height: 38px
    typography: 15px / 400 / 22.5px NanumBarunGothic
    states: rest on six links on the movie and booking routes (surface-2 and surface-3 capture 11-16); no state frame
    use: 'Main navigation link (a.gnb-txt-movie, .gnb-txt-reserve, .gnb-txt-theater and siblings) at surface-2::[data-omd-capture="11"]; the same links are #ffffff on the home (capture 12-17)'
  header-utility-link:
    type: button
    backgroundColor: transparent
    textColor: '#444444'
    height: 20px
    typography: 13.0005px / 400 / 19.5007px NanumBarunGothic
    states: rest on six links per route (surface-2 capture 1-6); no state frame
    use: 'Header utility link (a; no button role) above the main navigation at surface-2::[data-omd-capture="1"]; #888888 on the home (capture 2-7)'
  footer-link:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    height: 30px
    typography: 13.0005px / 400 / 30px NanumBarunGothic
    states: rest on six links per route (home capture 83-87, 90); no state frame
    use: 'Footer link (a; no button role) on all three routes at home::[data-omd-capture="83"]; two links per route are #222222 at 700 (home capture 88, 89)'
  theater-lookup-pill:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    border: '1px #d8d9db'
    rounded: 30px
    size: 106px x 30px
    typography: 13.0005px / 400 / 28px NanumBarunGothic
    states: rest on all three routes (home capture 91, surface-2 capture 118, surface-3 capture 27); no state frame
    use: Footer link (a.btn-looking-theater; no button role) at home::[data-omd-capture="91"]; the element behind the theater-lookup 30px radius token
  special-hall-card:
    type: card
    rounded: 10px
    size: 170px x 170px
    shadow: rgba(0, 0, 0, 0.2) 5px 5px 10px 0px
    states: rest on ten cards (home capture 63-72); no state frame
    use: Special-hall link card (a.bg-dolby, .bg-dva, .bg-mx4d and siblings) on the home at home::[data-omd-capture="63"]; its background colour is transparent and its type is 0px, so neither a fill nor a label style is claimed
fonts:
  roles:
    ui: NanumBarunGothic
---

# MEGABOX

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to MEGABOX; reproduced for educational reference. Full prose: https://oh-my-design.kr/megabox/design.md
