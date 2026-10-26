---
name: Loglass
colors:
  primary: '#2352c8'
  primary-hover: '#1337a1'
  primary-deep: '#062073'
  primary-surface: '#eef5ff'
  primary-tint: '#f8fafd'
  chart-blue-light: '#d5e4fb'
  foreground: '#171725'
  text-normal: '#3f3f4a'
  text-secondary: '#6c6c7f'
  text-placeholder: '#9090a1'
  disabled: '#b5b5be'
  border: '#d5d5dc'
  muted: '#f1f1f5'
  surface: '#fafafb'
  canvas: '#ffffff'
  night: '#000c2a'
  accent: '#e77623'
  accent-hover: '#c3540a'
  warning-surface: '#fff2de'
  info: '#026572'
  info-surface: '#f0f7ff'
  success: '#108a10'
  success-surface: '#eafbe5'
  danger: '#d3403a'
  danger-surface: '#ffede9'
  chart-turquoise: '#29a4b3'
  chart-green: '#37ac32'
  chart-red: '#ee6e66'
typography:
  xs:
    fontSize: 12px
    use: '--text-xs'
  sm:
    fontSize: 14px
    use: '--text-sm; header buttons and navigation'
  base:
    fontSize: 16px
    use: '--text-base'
  lg:
    fontSize: 18px
    use: '--text-lg'
  xl:
    fontSize: 20px
    use: '--text-xl'
  2xl:
    fontSize: 24px
    use: '--text-2xl'
  3xl:
    fontSize: 32px
    use: '--text-3xl'
  4xl:
    fontSize: 40px
    use: '--text-4xl'
  5xl:
    fontSize: 48px
    use: '--text-5xl; the home page h1'
  6xl:
    fontSize: 60px
    use: '--text-6xl'
  8xl:
    fontSize: 96px
    use: '--text-8xl, the largest step'
rounded:
  sm: 4px
  md: 8px
  xl: 12px
  2xl: 16px
  full: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#2352c8'
    textColor: '#ffffff'
    rounded: 4px
    height: 40px
    padding: 6px 12px
    typography: 14px / 700
    shadow: rgba(0,0,0,0.1) 0 1px 3px, rgba(0,0,0,0.1) 0 1px 2px -1px
    hover: '#1337a1'
    pressed: '#1337a1'
    use: 資料ダウンロード in the header — --color-cta-primary, deepening to --color-cta-primary-hover. Focus is the browser's ring.
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: '#171725'
    border: '#d5d5dc'
    rounded: 4px
    height: 40px
    padding: 6px 12px
    typography: 14px / 700
    hover: '#f1f1f5, border #b5b5be'
    pressed: '#f1f1f5, border #b5b5be'
    use: お問い合わせ — an outlined twin that fills with --color-neutral-2 and darkens its border on hover.
  card-cta:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#171725'
    rounded: 4px
    shadow: 0 0 0 3px rgba(255,255,255,0.5)
    hover: 'ring 0 0 0 3px #e77623'
    pressed: 'ring 0 0 0 3px #e77623'
    use: '無料デモを体験する on the hero — a white card with a translucent 3px ring (--shadow-cta-card) that turns solid orange #e77623 on hover (--shadow-cta-card-hover).'
  link-nav:
    type: button
    backgroundColor: transparent
    textColor: '#171725'
    height: 44px
    padding: 0 8px
    typography: 14px / 600
    hover: 'fg #2352c8'
    pressed: 'fg #2352c8'
    use: Header navigation (サービス一覧 and siblings). The label turns brand blue on hover — the only place the link colour appears at rest-to-hover.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Noto Sans JP
---

# Loglass

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Loglass; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/loglass/DESIGN.md
