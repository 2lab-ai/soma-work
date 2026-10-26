---
name: DeepL
colors:
  brand: '#0f2b46'
  brand-hover: '#091a2b'
  mint-pressed: '#6cf1c9'
  primary: '#0070c9'
  primary-hover: '#0053a9'
  primary-pressed: '#00388d'
  primary-muted: '#e0f0ff'
  alternative-border: '#6d5cd8'
  foreground: '#191919'
  text-strong: '#292929'
  text-secondary: '#6f6f6f'
  canvas: '#ffffff'
  surface-secondary: '#f5f5f5'
  basic-pressed: '#e5e5e5'
  border-hover: '#c6c6c6'
  hover-light: '#f8f8f8'
  success: '#007f59'
  danger: '#c34331'
  warning: '#c9a800'
typography:
  heading:
    fontSize: 32px
    fontWeight: 400
    use: section headings
  button:
    fontSize: 18px
    fontWeight: 400
    use: header pills
rounded:
  md: 8px
  pill: 40px
components:
  button-brand:
    type: button
    backgroundColor: '#0f2b46'
    textColor: '#ffffff'
    rounded: 40px
    height: 45px
    padding: 13px 16px 14px
    typography: 18px / 400
    hover: '#091a2b'
    pressed: '#6cf1c9'
    use: 'Start free trial — brand navy pill that deepens on hover and flashes mint #6cf1c9 with navy text when pressed.'
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#0f2b46'
    rounded: 40px
    height: 45px
    padding: 13px 16px 14px
    typography: 18px / 400
    hover: '#f8f8f8'
    pressed: '#6cf1c9'
    use: Log in — white pill with navy text; the same mint press.
  tab-product:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#292929'
    rounded: 8px
    height: 40px
    padding: 8px 16px
    typography: 16px / 600
    shadow: 'inset 0 0 0 1px #e5e5e5'
    hover: '#f5f5f5'
    pressed: '#e5e5e5'
    focus: 'outline 2px solid #0070c9'
    use: 'Translate files / speech / Use API — basic action tabs (--dui-color-background-action-basic-*) with a 1px inset border that darkens to #c6c6c6; the active tab is #e0f0ff with #0053a9 text.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: robotoLatin
---

# DeepL

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to DeepL; reproduced for educational reference. Full prose: https://oh-my-design.kr/deepl/design.md
