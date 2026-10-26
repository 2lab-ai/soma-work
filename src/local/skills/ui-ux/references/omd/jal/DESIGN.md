---
name: JAL
colors:
  brand: '#cc0000'
  brand-pressed: '#a30000'
  foreground: '#000000'
  subtle: '#666666'
  disabled: '#999999'
  informative: '#2a344b'
  informative-pressed: '#4c559b'
  canvas: '#ffffff'
  border: '#d5d5d5'
  surface-muted: '#e2e7ed'
  surface-alert: '#fdf5f5'
  surface-emphasis: '#e8e8e8'
  neutral-3: '#f5f6f6'
  neutral-80: '#333333'
  icon-white-pressed: '#e1e3e6'
  accent-steel-blue: '#6a7181'
  accent-gray-blue: '#b7c1cd'
  accent-light-cyan: '#f0f7ff'
  red-10: '#fae5e5'
  red-20: '#f7d6d6'
  red-60: '#d63131'
  red-75: '#b80000'
  jmb-crystal-red: '#ba1334'
  jmb-sapphire-blue: '#066fbf'
  jmb-emblem-gold: '#edc900'
  jmb-emblem-bronze: '#733b11'
  jmb-blue: '#0f327b'
  jmb-green: '#097048'
  jgc-three-star: '#960a20'
  jgc-four-star: '#112a6c'
  jgc-five-star: '#535a60'
  jmb-elite: '#652d73'
typography:
  caption:
    fontSize: 11px
    use: '--text-caption-sm and --fontSize-11; the smallest step'
  small:
    fontSize: 12px
    use: '--text-body-sm, -caption-md and -label-xs'
  body:
    fontSize: 14px
    use: '--text-body-md, -caption-lg and -label-sm; the login button''s label'
  base:
    fontSize: 16px
    use: '--text-body-lg and -heading-xs; 188 of 232 rendered text elements'
  lead:
    fontSize: 18px
    use: '--text-body-xl, -heading-sm and -label-lg'
  title:
    fontSize: 20px
    use: '--fontSize-20'
  heading:
    fontSize: 24px
    use: '--fontSize-24'
  heading-lg:
    fontSize: 28px
    use: '--fontSize-28'
  display-sm:
    fontSize: 32px
    use: '--fontSize-32'
  display:
    fontSize: 36px
    use: '--fontSize-36'
  display-lg:
    fontSize: 40px
    use: '--fontSize-40; the largest published step'
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  lg: 16px
  pill: 9999px
spacing:
  s4: 4
  s8: 8
  s16: 16
  s20: 20
  s24: 24
  s32: 32
  s40: 40
  s48: 48
  s64: 64
  s96: 96
components:
  button-primary:
    type: button
    backgroundColor: '#cc0000'
    textColor: '#ffffff'
    border: '1px solid #cc0000'
    rounded: 9999px
    height: 34px
    typography: 14px / 700
    hover: '#cc0000'
    focus: '#cc0000'
    use: 'The sign-in pill in the header, 193×34. Hover changes nothing; focus draws a #cc0000 2px solid ring, which is --strokeColor-focus-primary.'
  nav-link:
    type: tab
    backgroundColor: '#ffffff'
    textColor: '#000000'
    rounded: 0px
    height: 47px
    typography: 16px / 700
    hover: '#cc0000'
    focus: '#cc0000'
    use: 'Global navigation item, 80×47. Hover turns the label #cc0000 and grows a 3px bottom border in the same red; focus adds a #cc0000 1px solid ring and a 2px radius on top of that.'
fonts:
  roles:
    sans: Noto Sans JP
    english: Noto Sans
    korean: Noto Sans KR
    thai: Noto Sans Thai
    chinese-simplified: Noto Sans SC
    chinese-traditional: Noto Sans TC
    chinese-hongkong: Noto Sans HK
---

# JAL

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to JAL; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/jal/DESIGN.md
