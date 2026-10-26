---
name: Shinhan Bank
colors:
  brand-primary: '#0046ff'
  group-live-blue: '#005df9'
  group-ink: '#24272d'
  group-surface: '#f3f6fb'
  canvas: '#ffffff'
  on-dark: '#ffffff'
  banking-text: '#666666'
typography:
  banking-body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 17.5px
    letterSpacing: '-0.28px'
    use: Observed on the public internet-banking surface only.
  group-action:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 46px
    letterSpacing: '-0.5px'
    use: Observed on group corporate action links only.
  brand-hero:
    fontSize: 46px
    fontWeight: 700
    use: Observed group-corporate hero only.
rounded:
  group-action: 30px
  group-selector: 24px
spacing:
  group-action-inline: 24
  group-action-leading: 56
  group-selector-inline: 20
components:
  group-outline-action:
    type: button
    backgroundColor: rgba(0, 93, 249, 0.3)
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 30px
    padding: 0px 56px 0px 24px
    height: 48px
    typography: 16px / 400 / Pretendard
    states: default captured on five links (captures 13-17); the bundle holds no state frame for any element
    use: Group corporate marketing action link (a.roundbt.ico.link.type2) at surface-2::[data-omd-capture="13"]; line height 46px, tracking -0.5px. Corporate-marketing control only, not SOL Bank or transaction UI
  group-download-action:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    textColor: '#ffffff'
    border: '1px #ffffff'
    rounded: 30px
    padding: 0px 48px 0px 24px
    height: 48px
    typography: 16px / 500 / Pretendard
    states: default captured on two links (captures 26 and 27); no state frame
    use: Group corporate download link (a.roundbt.ico.down.type2) at surface-2::[data-omd-capture="26"]; corporate-marketing control only
  family-site-selector:
    type: button
    backgroundColor: '#f3f6fb'
    textColor: '#24272d'
    rounded: 24px
    padding: 0px 20px
    height: 48px
    typography: 16px / 400 / Pretendard
    states: default captured; no expanded-menu record and no state frame
    use: Group Family Site selector (button.btn_selct) at surface-2::[data-omd-capture="40"], 205 px wide, line height 48px
    pressed: no visible change (measured 2026-10-16) (:hover + :active)
  group-gnb-link:
    type: tab
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 0px 36px
    height: 92px
    typography: 18px / 700 / OneShinhan
    states: default captured on six top-level links; no state frame
    use: 'Group corporate top-level navigation link (a.depth1) at surface-2::[data-omd-capture="1"], white over the hero slider at capture time. Its li.gnb_li container computes #24272d / 16px / 500, which is not the link style'
  group-header-selector:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    rounded: 0px
    padding: 1px 6px 1px 8px
    height: 36px
    typography: 18px / 700 / OneShinhan
    states: default captured; no state frame
    use: Two-character header selector (button.btn_selct) at surface-2::[data-omd-capture="7"]; it shares its class with the Family Site selector but computes a transparent, white-text treatment
  group-round-link:
    type: button
    backgroundColor: rgba(255, 255, 255, 0.2)
    rounded: 50%
    padding: 0px
    size: 40px x 40px
    states: default captured on ten links; no state frame
    use: Circular icon link (a.golink) at surface-2::[data-omd-capture="11"]; its text is visually hidden (1px font, transparent colour), so no label style is declared
  banking-text-link:
    type: button
    backgroundColor: transparent
    textColor: '#2d71c4'
    height: 20px
    typography: 16px / 700 / Spoqa
    states: default captured; no state frame
    use: Public internet-banking text link (a.w2anchor2.btnLink) at home::[data-omd-capture="20"]; line height 20px, tracking -0.32px
  banking-more-link:
    type: button
    backgroundColor: transparent
    textColor: '#666666'
    padding: 0px 15px 0px 0px
    height: 18px
    typography: 14px / 400 / Spoqa
    states: default captured; no state frame
    use: Public internet-banking more link (a.w2anchor2.btnMoreTxt, class bul01) at home::[data-omd-capture="29"]; line height 17.5px
  banking-page-top:
    type: button
    backgroundColor: '#4f4d4c'
    rounded: 2px
    padding: 0px
    size: 32px x 32px
    states: default captured on internet banking and on www.shinhan.com (surface-3 capture 95); no state frame
    use: 'Page-top control (a.w2anchor2.btnPageTop) at home::[data-omd-capture="55"]; its computed #666666 / 14px / 400 equal the page inherited body text, so no label style is declared'
  banking-menu-cell:
    type: listItem
    backgroundColor: transparent
    border: '1px #dcdcdc'
    size: 154px x 56px
    states: default captured on six cells; no state frame
    use: 'Public internet-banking menu grid cell (li.w2group) at home::#wq_uuid_1101; the border is drawn on the top and left edges only (1px 0px 0px 1px). Its #666666 / 14px / 400 are container values'
  recommendation-card:
    type: card
    backgroundColor: '#aadaff'
    padding: 30px 0px 25px
    size: 232px x 257px
    states: 'default captured; the second card (surface-3::#grp_prod2) fills #7ae6e9 with the same geometry; no state frame'
    use: 'www.shinhan.com product recommendation card (li.w2group.recom1) at surface-3::#grp_prod1, on the public-marketing page, not internet banking. Its #666666 / 14px / 400 are container values'
fonts:
  roles:
    banking: Spoqa
    group: Pretendard
    brand: OneShinhan
---

# Shinhan Bank

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Shinhan Bank; reproduced for educational reference. Full prose: https://oh-my-design.kr/shinhanbank/design.md
