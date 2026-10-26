---
name: NewsPicks
colors:
  accent: '#146af5'
  accent-hover: '#0032ca'
  accent-inverse: '#4b9dfa'
  accent-surface: '#ebf3ff'
  accent-surface-hover: '#d6e6ff'
  foreground: '#222222'
  disabled: '#a3a3a3'
  canvas: '#ffffff'
  premium: '#00b357'
  premium-hover: '#007d3c'
  premium-surface: '#f0faf5'
  campaign-yellow: '#ffc800'
  ai: '#9b2cc1'
  bookpicks: '#f7f3eb'
  highlight: '#ffe86b'
  investment-gold: '#886c0f'
  caution: '#de3535'
  caution-hover: '#ab0000'
  recommend: '#ed5353'
  success: '#018a26'
  success-hover: '#044f20'
  success-surface: '#e8ffe8'
  caution-surface: '#fff0f0'
  caution-surface-hover: '#ffdbdb'
  unread: '#ebf3ff'
  unread-hover: '#d6e6ff'
  inverse-hover: '#474747'
  palette-blue-100: '#d6e6ff'
  palette-blue-400: '#4b9dfa'
  palette-blue-500: '#2986ff'
  palette-blue-700: '#0040e0'
  palette-gray-100: '#e6e6e6'
  palette-gray-500: '#616161'
  palette-gray-700: '#333333'
  palette-red-50: '#fff0f0'
  palette-red-100: '#ffdbdb'
  palette-red-400: '#fa7373'
  palette-red-700: '#d41717'
  palette-green-100: '#d0f2d0'
  palette-green-500: '#239e2f'
  palette-green-700: '#037020'
  social-facebook: '#0866ff'
  social-linkedin: '#2967b2'
  social-bizd: '#0081cc'
  social-apple: '#000000'
typography:
  micro:
    fontSize: 10px
    use: Timestamps and pick counts; 20 rendered elements
  caption:
    fontSize: 11px
    use: The smallest label step
  base:
    fontSize: 12px
    use: The page's default — 138 of 286 text-bearing elements, including every control label
  body:
    fontSize: 13px
    use: Comment body
  reading:
    fontSize: 14px
    use: Article summaries; 43 elements
  lead:
    fontSize: 16px
    use: Headlines in the feed; 42 elements
  title:
    fontSize: 18px
    use: Section titles
  heading:
    fontSize: 20px
    use: The largest rendered step
rounded:
  xs: 2px
  sm: 4px
  md: 8px
  pill: 20px
  circle: 9999px
components:
  button-login:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    border: '1px solid #222222'
    rounded: 4px
    height: 32px
    padding: 0 12px
    typography: 12px / 400
    hover: rgba(34,34,34,0.05)
    pressed: rgba(34,34,34,0.05)
    use: ログイン — the outline action, 73×32. Hover and pressed wash the fill with ink at 5%, which is --surface-color-base-primary-hover exactly.
  button-premium:
    type: button
    backgroundColor: '#146af5'
    textColor: '#ffffff'
    rounded: 4px
    height: 32px
    padding: 0 12px
    typography: 12px / 400
    hover: '#0032ca'
    pressed: '#0032ca'
    use: 'プレミアムを無料で体験 — the filled action, 160×32. Hover and pressed are --surface-color-accent-primary-hover; note the button is accent blue while the Premium product colour is the green #00b357.'
  tab-active:
    type: tab
    backgroundColor: '#146af5'
    textColor: '#ffffff'
    rounded: 20px
    height: 40px
    padding: 0 16px
    typography: 12px / 400
    hover: '#146af5'
    pressed: '#146af5'
    use: The selected feed tab (総合), 58×40 — a blue pill. Hover and pressed change nothing; the current tab does not respond to the pointer.
  tab-inactive:
    type: tab
    backgroundColor: transparent
    textColor: '#222222'
    border: '1px solid #222222'
    rounded: 20px
    height: 40px
    padding: 0 16px
    typography: 12px / 400
    hover: rgba(34,34,34,0.05)
    pressed: rgba(34,34,34,0.05)
    use: An unselected feed tab (ワールド), 86×40 — outlined, and it takes the same 5% ink wash as the login button.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# NewsPicks

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to NewsPicks; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/newspicks/DESIGN.md
