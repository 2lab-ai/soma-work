---
name: WPS Office
colors:
  brand: '#1f69e0'
  brand-hover: '#458bfa'
  brand-pressed: '#1e5fc7'
  brand-light: '#edf4ff'
  brand-deep: '#0a306c'
  danger: '#dd3332'
  danger-hover: '#c42e2d'
  danger-pressed: '#b02928'
  success: '#418f1f'
  warning: '#e2651a'
  ai: '#8350f2'
  ai-hover: '#9c75f0'
  ai-pressed: '#682aef'
  ai-light: '#f4effd'
  foreground: '#0d0d0d'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-base: '#eeeeee'
  frame: '#e6e6e6'
typography:
  micro:
    fontSize: 10px
    use: '--kd-font-size-extra-small; the smallest published step'
  small:
    fontSize: 12px
    use: '--kd-font-size-small; metadata and fine print'
  base:
    fontSize: 14px
    use: '--kd-font-size-base; the system default and the dropdown label'
  medium:
    fontSize: 16px
    use: '--kd-font-size-middle; the header nav items'
  large:
    fontSize: 18px
    use: '--kd-font-size-large; all three hero buttons'
  xlarge:
    fontSize: 20px
    use: '--kd-font-size-extra-large'
  xxlarge:
    fontSize: 24px
    use: '--kd-font-size-xx-large'
  xxxlarge:
    fontSize: 28px
    use: '--kd-font-size-xxx-large'
  hero:
    fontSize: 62px
    use: '--wps-font-size-hero; the landing headline, page-level not system'
rounded:
  none: 0px
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  circle: 999px
components:
  button-primary:
    type: button
    backgroundColor: '#dd3332'
    textColor: '#ffffff'
    rounded: 40px
    padding: 0 15px
    typography: 18px / 600
    hover: '#c42e2d'
    pressed: '#b02928'
    focus: '#dd3332'
    use: 立即下载 (Download now) — the headline call to action, 193×54. Painted from the error ramp, not the brand ramp. Focus matches :focus-visible and changes nothing.
    height: 54px
  button-secondary:
    type: button
    backgroundColor: transparent
    textColor: rgba(13,13,13,.9)
    border: 1px solid rgba(13,13,13,.48)
    rounded: 40px
    padding: 0 15px
    typography: 18px / 600
    hover: rgba(13,13,13,.06)
    pressed: rgba(13,13,13,.1)
    focus: transparent
    use: '在线使用 (Use online) — the outline twin of the headline button, same 193×54 and same 40px radius. Every value is a named token: the border is line-heavy, the hover and pressed fills are bg-hover and bg-pressed.'
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: rgba(13,13,13,.9)
    rounded: 6px
    padding: 0 11px
    typography: 16px / 400
    hover: rgba(13,13,13,.06)
    pressed: rgba(13,13,13,.06)
    focus: transparent
    use: Header nav item (产品), 72×30. Hover and pressed are the same 6% wash — the nav does not deepen on press.
  button-light:
    type: button
    backgroundColor: transparent
    textColor: rgba(13,13,13,.66)
    rounded: 6px
    padding: 0 11px 0 15px
    typography: 14px / 400
    hover: rgba(13,13,13,.9)
    pressed: rgba(13,13,13,.06)
    focus: transparent
    use: '更多下载 (More downloads) dropdown trigger, 100×32. The only control that moves its label rather than its fill on hover: text-secondary to text-primary, then a 6% wash on press.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# WPS Office

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to WPS Office; reproduced for educational reference. Full prose: https://oh-my-design.kr/wps/design.md
