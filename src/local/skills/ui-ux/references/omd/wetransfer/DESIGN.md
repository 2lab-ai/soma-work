---
name: WeTransfer
colors:
  base: '#3767ea'
  base-hover: '#4e7df7'
  base-active: '#1842ce'
  base-tint: '#f5f8ff'
  neutral: '#353535'
  neutral-hover: '#464646'
  neutral-active: '#161616'
  neutral-tint: '#f1f1f1'
  upsell: '#8e21cc'
  upsell-hover: '#a035e2'
  upsell-active: '#650095'
  destructive: '#b82b00'
  foreground: '#161616'
  text-muted: '#676767'
  canvas: '#ffffff'
  gray-10: '#f9f9f9'
  gray-30: '#d6d6d6'
  success: '#3a9249'
  warning: '#fbc738'
typography:
  small:
    fontSize: 14px
    fontWeight: 500
    use: navigation and buttons
rounded:
  sm: 8px
  md: 12px
components:
  button-signup:
    type: button
    backgroundColor: '#353535'
    textColor: '#f1f1f1'
    rounded: 8px
    height: 32px
    padding: 6px 12px
    typography: 14px / 500
    hover: '#464646'
    pressed: '#161616'
    focus: 'ring 0 0 0 4px #464646'
    use: 'Sign up — the neutral action (--wt-color-neutral-*): #353535 → hover #464646 → active #161616 with a white label; focus a 4px #464646 ring.'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#353535'
    rounded: 0px
    height: 48px
    typography: 14px / 500
    hover: 'fg #676767'
    pressed: 'fg #676767'
    focus: 'outline 1px solid #4e7df7'
    use: 'Log in in the top navigation — #353535 text greying to #676767 on hover; focus a 1px blue outline with a soft blue glow.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: GT Super WT
    sans: Actief Grotesque
---

# WeTransfer

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to WeTransfer; reproduced for educational reference. Full prose: https://oh-my-design.kr/wetransfer/design.md
