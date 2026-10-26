---
name: Reddit
colors:
  primary: '#FF4500'
  primary-interactive: '#D93900'
  primary-hover: '#AE2C00'
  brand-orangered: '#FF4500'
  alien-blue: '#1870F4'
  action-primary: '#0A449B'
  action-secondary: '#0A2F6C'
  downvote: '#6A5CFF'
  downvote-hover: '#523DFF'
  canvas: '#FFFFFF'
  canvas-weak: '#F6F8F9'
  canvas-container: '#EEF1F3'
  surface: '#E5EBEE'
  foreground-strong: '#181C1F'
  foreground: '#333D42'
  foreground-weak: '#5C6C74'
  on-primary: '#FFFFFF'
  link: '#115BCA'
  link-hover: '#0A449B'
  link-visited: '#9B00D4'
  divider: '#E5EBEE'
  success: '#008A10'
  error: '#BC0117'
  warning: '#B78800'
  dark-bg: '#2A3236'
typography:
  display-lg:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Page/subreddit headings
  body-lg:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.33
    use: Post titles (prominent)
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: Body text, comments, descriptions
  body-sm:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Metadata, upvote counts, timestamps
  label:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    use: Button labels, nav items
  label-sm:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1
    use: Badge labels, flair text
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 20
  xl: 24
  xxl: 32
  section: 48
components:
  button-primary:
    type: button
    backgroundColor: '#D93900'
    textColor: '#ffffff'
    rounded: 999px
    height: 40px
    padding: 0px 12px
    typography: 14px / 600
    hover: '#AE2C00'
    use: Log In / primary CTA — OrangeRed pill
  button-secondary:
    type: button
    backgroundColor: '#E5EBEE'
    textColor: '#000000'
    rounded: 999px
    height: 40px
    padding: 0px 12px
    typography: 14px / 600
    hover: '#DBE4E9'
    use: Sign Up / secondary action
  button-outlined:
    type: button
    backgroundColor: transparent
    textColor: '#181C1F'
    border: 1px solid rgba(0,0,0,0.498)
    rounded: 999px
    height: 38px
    padding: 0px 11px
    typography: 14px / 600
    use: Create Post / ghost outlined action
  input-search:
    type: input
    backgroundColor: '#F8F8F8'
    border: 1px solid transparent
    rounded: 999px
    typography: 14px / 400
    focus: '#0A449B border'
    use: Global search bar
  post-card:
    type: card
    backgroundColor: '#FFFFFF'
    border: 1px solid rgba(0,0,0,0.2)
    rounded: 16px
    shadow: 0 0.0625rem 0.25rem 0 rgba(0,0,0,0.149)
    use: Post card in feed
  badge-flair:
    type: badge
    backgroundColor: '#E5EBEE'
    textColor: '#333D42'
    rounded: 9999px
    padding: 2px 8px
    typography: 12px / 600
    use: Post flair / subreddit flair
  upvote-tab:
    type: tab
    active: 'text #FF4500 + icon fill'
    textColor: '#5C6C74'
    use: Upvote/downvote indicator (active = OrangeRed)
  nav-item:
    type: tab
    textColor: '#333D42'
    active: '#181C1F font-weight 600'
    typography: 14px / 400
    use: Top navigation tabs (Best/Hot/New/Top)
  toggle-switch:
    type: toggle
    backgroundColor: '#0A449B'
    rounded: 9999px
    use: Settings toggle — alien blue when checked
  dialog-modal:
    type: dialog
    backgroundColor: '#FFFFFF'
    rounded: 16px
    shadow: 0px 2px 15px rgba(26, 26, 27, 0.3)
    use: Login/signup modal dialog
fonts:
  roles:
    sans: '-apple-system, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif'
    mono: Noto Mono, monospace
---

# Reddit

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Reddit; reproduced for educational reference. Full prose: https://oh-my-design.kr/reddit/design.md
