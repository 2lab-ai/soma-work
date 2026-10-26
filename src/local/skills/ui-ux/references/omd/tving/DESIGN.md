---
name: TVING
colors:
  canvas: '#000000'
  surface-raised: '#2e2e2e'
  foreground: '#ffffff'
  foreground-secondary: '#a3a3a3'
  foreground-muted: '#6e6e6e'
  hairline: '#4f4f4f'
typography:
  compact:
    fontSize: 13.2px
    fontWeight: 400
    lineHeight: 1.5
    use: Observed opened-menu text on home and movie surfaces.
  body:
    fontSize: 16.5px
    fontWeight: 400
    lineHeight: 1.15
    use: Observed product-surface body and utility text.
  heading:
    fontSize: 22.0044px
    fontWeight: 700
    lineHeight: 1.5
    use: Observed product-surface heading text.
  live-tab:
    fontSize: 14.2956px
    fontWeight: 400
    lineHeight: 1.15
    use: Observed unselected live-route tab text.
rounded:
  menu: 4.95px
  live-pill: 109.996px
components:
  content-menu-trigger:
    type: button
    backgroundColor: '#000000'
    textColor: '#a3a3a3'
    rounded: 4.95px
    padding: 0px 16.5px
    typography: 13.2/400 Pretendard
    states: expanded, menu-open
    use: 'Combobox trigger (aria-haspopup=menu) at home::[data-omd-capture="19"] and "20" on home and movie; it sits in the footer row (top 647px, beside the footer links at 646px). Corrected 2026-09-29: its border width computes 0px, so the July border value is removed.'
  live-selected-tab:
    type: tab
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#ffffff'
    rounded: 109.996px
    padding: 8.8044px 13.2px
    typography: 14.2956/700 Pretendard
    states: selected
    use: 'Observed selected tab on the supplied live route only (surface-3::[data-omd-capture="61"]); live-channel-tab records the same row with its unselected rest. Corrected 2026-09-29: its border width computes 0px, so the July border value is removed.'
  content-menu-listbox:
    type: card
    backgroundColor: '#212121'
    textColor: '#a3a3a3'
    border: '1px #4f4f4f'
    rounded: 4.95px
    padding: 0px
    size: 144px x 305px
    typography: 13.2px / 400 / 15.18px Pretendard
    shadow: rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px
    states: captured open after the collector opened its trigger (menu interaction recording expanded and menu-open); two listboxes on home and two on movie; no pointer-state frame
    use: Opened listbox of the combobox trigger at home::[data-omd-interaction-capture="menu-0-0"]; the computed shadow lists two alpha-0 layers before these two
  content-menu-option:
    type: listItem
    backgroundColor: transparent
    textColor: '#a3a3a3'
    rounded: 0px
    padding: 4.95px 6.6px
    height: 30px
    typography: 13.2px / 400 / 19.8px Pretendard
    states: 'rest captured inside the opened listbox; the first option of every captured listbox (menu-0-3 and menu-1-3 on home and movie) computes bg #2e2e2e with aria-selected false, and the dump does not say which state paints it, so it is not declared'
    use: Listbox option (role=option) at home::[data-omd-interaction-capture="menu-0-4"]
  header-nav-link:
    type: tab
    backgroundColor: transparent
    textColor: rgba(255, 255, 255, 0.6)
    rounded: 0px
    padding: 0px
    height: 16px
    typography: 16px / 400 / 16px Pretendard
    selected: 'fg #ffffff, 16px / 700'
    states: 'rest and current-page link (class on) captured on the movie route; home computes rgba(255, 255, 255, 0.9) on all eight links with no current item, and the live route #ffffff / 400 on all eight; no pointer-state frame'
    use: Header navigation link (a.other) at surface-2::[data-omd-capture="1"]; the current-page link is "3" (a.other.on)
  header-subscribe-pill:
    type: button
    textColor: '#ffffff'
    rounded: 42px
    padding: 0px 12px
    size: 61px x 33px
    typography: 14px / 700 / 16.1px Pretendard
    states: default captured on all three routes; no pointer-state frame
    use: Header pill link at home::[data-omd-capture="9"]; its computed background-color is transparent on all three routes, the live copy names a gradient utility in its class list, and background-image is not in the dump, so no fill is claimed
  landing-cta:
    type: button
    backgroundColor: '#dedede'
    textColor: '#000000'
    rounded: 3px
    padding: 17.5956px 200.204px 19.8px
    height: 57px
    typography: 19.8px / 700 / 19.8px Pretendard
    states: default captured on home and movie (529 x 57 at top 459px on both); no pointer-state frame
    use: Large light-grey button at home::[data-omd-capture="11"]
  live-white-pill-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 3.35544e+07px
    padding: 13.2px 26.4px
    height: 46px
    typography: 16.5px / 700 / 18.975px Pretendard
    states: default captured; no pointer-state frame
    use: Live-route white pill button at surface-3::[data-omd-capture="11"]; the computed radius is the rounded-full utility value and renders as a full pill
  live-round-icon-button:
    type: button
    backgroundColor: '#27272e'
    rounded: 3.35544e+07px
    padding: 0px
    size: 44px x 44px
    states: default captured; it declares aria-haspopup=dialog, but the collector opened no dialog and recorded no pointer-state frame for it
    use: Live-route round icon button at surface-3::[data-omd-capture="15"]; it has no text node, so no label colour is claimed
  live-channel-tab:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 8.8044px 13.2px
    height: 34px
    typography: 14.2956px / 400 / 16.4399px Pretendard
    selected: bg rgba(255, 255, 255, 0.2), 14.2956px / 700, radius 109.996px
    states: unselected rest (capture 62, aria-selected=false) and the selected tab (capture 61, aria-selected=true, also recorded on its own as live-selected-tab); thirteen tabs in the row; no pointer-state frame
    use: Live-route tab (li role=tab) at surface-3::[data-omd-capture="62"]
  footer-link:
    type: tab
    backgroundColor: transparent
    textColor: '#a3a3a3'
    rounded: 0px
    padding: 0px
    height: 20px
    typography: 16.5px / 400 / 18.975px Pretendard
    states: default captured on seven links per route (home and movie 12-18, live 74-80); the third link in each row is 700 weight; no pointer-state frame
    use: 'Footer policy link row at home::[data-omd-capture="12"]; a smaller underlined link below it (capture 21) computes #6e6e6e at 14.2956px / 400'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: Pretendard
---

# TVING

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to TVING; reproduced for educational reference. Full prose: https://oh-my-design.kr/tving/design.md
