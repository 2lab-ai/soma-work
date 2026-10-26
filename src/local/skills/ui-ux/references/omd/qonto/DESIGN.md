---
name: Qonto
colors:
  primary: '#050505'
  foreground: '#050505'
  grey-900: '#1a1a1a'
  grey-800: '#262626'
  grey-700: '#3d3d3d'
  text-secondary: '#616161'
  grey-500: '#8f8f8f'
  grey-300: '#cccccc'
  grey-200: '#e0e0e0'
  grey-100: '#e8e8e8'
  surface: '#f5f5f5'
  canvas: '#ffffff'
  pressed: '#373737'
  blueberry: '#3275c4'
  blueberry-product-100: '#dceaff'
  blueberry-product-50: '#e0eafb'
  blueberry-1000: '#093b75'
  blueberry-product-1000: '#163470'
  plum: '#6e45e3'
  plum-50: '#d5c8ff'
  peach-50: '#ffc9a6'
  sakura-50: '#ffdfea'
  mint-50: '#c8ffec'
  mustard-50: '#faffa4'
  success: '#0f7a3d'
  danger: '#b81818'
  warning: '#b04e10'
typography:
  body:
    fontSize: 16px
    use: buttons, navigation and tabs, 400
  t20:
    fontSize: 20px
    use: '--text-20'
  t22:
    fontSize: 22px
    use: '--text-22'
  t40:
    fontSize: 40px
    use: '--text-40'
  t72:
    fontSize: 72px
    use: '--text-72'
  t88:
    fontSize: 88px
    use: '--text-88'
  t128:
    fontSize: 128px
    use: '--text-128, the largest display size'
rounded:
  sm: 4px
  md: 8px
  lg: 24px
  xl: 32px
  pill: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#050505'
    textColor: '#ffffff'
    rounded: 8px
    height: 48px
    padding: 12px 16px
    typography: 16px / 400
    hover: rgba(29,29,27,0.92)
    pressed: '#373737'
    use: 'Démarrer on a pricing plan — solid near-black; hover fades it slightly, press lightens to #373737. Focus is the browser''s ring.'
  button-outline:
    type: button
    backgroundColor: transparent
    textColor: '#050505'
    border: '#050505'
    rounded: 8px
    height: 48px
    padding: 11px 16px
    typography: 16px / 400
    hover: rgba(29,29,27,0.08)
    pressed: rgba(29,29,27,0.12)
    use: The outlined Démarrer on other plan cards — a near-black wash at 8% on hover and 12% on press.
  tab:
    type: button
    backgroundColor: transparent
    textColor: '#3d3d3d'
    rounded: 4px
    height: 44px
    padding: 10px 16px
    typography: 16px / 400
    hover: 'fg #000000'
    pressed: 'fg #000000'
    use: The pricing segment tabs (TPE/PME …) — the label darkens to black on hover.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: QontoSans
---

# Qonto

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Qonto; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/qonto/DESIGN.md
