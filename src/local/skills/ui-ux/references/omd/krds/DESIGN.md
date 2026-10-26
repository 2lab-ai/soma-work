---
name: KRDS
colors:
  primary: '#256ef4'
  primary-hover: '#0b50d0'
  primary-deep: '#083891'
  brand: '#256ef4'
  canvas: '#ffffff'
  foreground: '#1e2124'
  muted: '#6d7882'
  on-primary: '#ffffff'
  surface: '#f4f5f6'
  surface-primary: '#ecf2fe'
  hairline: '#b1b8be'
  border-strong: '#58616a'
  body: '#464c53'
  secondary: '#346fb2'
  point: '#d63d4a'
  danger: '#de3412'
  warning: '#ffb114'
  success: '#228738'
  information: '#0b78cb'
typography:
  display-large:
    fontSize: 60px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: Marketing/banner display (no body use)
  display-small:
    fontSize: 36px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: Small display banner
  heading-xlarge:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: H1 page/section top title (28px mobile)
  heading-large:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: 1px
    use: H1 narrow / H2
  heading-medium:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.5
    use: H2 / H3
  heading-small:
    fontSize: 19px
    fontWeight: 700
    lineHeight: 1.5
    use: H3 / H4
  heading-xsmall:
    fontSize: 17px
    fontWeight: 700
    lineHeight: 1.5
    use: H4 / H5
  body-large:
    fontSize: 19px
    fontWeight: 400
    lineHeight: 1.5
    use: Emphasized body / key copy
  body-medium:
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard body (default)
  body-small:
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.5
    use: Caption / small label
  body-xsmall:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Annotation / meta / footer
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  full: 1000px
spacing:
  xs: 2
  sm: 4
  md: 8
  base: 16
  lg: 24
  xl: 32
  xxl: 40
components:
  button-primary:
    type: button
    backgroundColor: '#256ef4'
    textColor: '#ffffff'
    border: '1px solid #256ef4'
    rounded: 6px
    padding: 0 16px
    height: 48px
    typography: 17px / 400
    hover: '#0b50d0'
    active: '#083891'
    focus: '#083891'
    disabled: 'bg #cdd1d5 fg #6d7882'
    use: Core action 신청하기/확인 (1 per screen)
  button-secondary:
    type: button
    backgroundColor: '#ecf2fe'
    textColor: '#0b50d0'
    border: '1px solid #256ef4'
    rounded: 6px
    padding: 0 16px
    height: 48px
    typography: 17px / 400
    hover: '#d8e5fd'
    pressed: '#b1cefb'
    focus: '#b1cefb'
    states: default; shared 4px focus halo and aria-disabled behavior
    use: Secondary action 자세히 보기/이전 단계
  button-tertiary:
    type: button
    backgroundColor: transparent
    textColor: '#1e2124'
    border: '1px solid #58616a'
    rounded: 6px
    padding: 0 16px
    height: 48px
    typography: 17px / 400
    hover: '#f4f5f6'
    pressed: '#e6e8ea'
    focus: '#e6e8ea'
    use: Cancel/reset 취소/초기화/닫기
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#464c53'
    border: '1px solid #58616a'
    rounded: 8px
    padding: 0 16px
    height: 56px
    typography: 19px / 400
    focus: '0 0 0 4px #256ef4 halo'
    disabled: 'bg #cdd1d5 fg #6d7882 border #b1b8be'
    states: 'error border 2px solid #de3412'
    use: Standard text input (large default)
  select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1e2124'
    border: '1px solid #58616a'
    rounded: 6px
    padding: 0 48px 0 16px
    height: 56px
    typography: 19px / 400
    disabled: 'bg #cdd1d5 border #b1b8be'
    states: 'error border 2px solid #ab2b36'
    use: Native select with chevron
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#1e2124'
    rounded: 12px
    padding: 40px
    shadow: 0 0.2rem 0 0 rgba(0,0,0,0.1), 0 0.4rem 0.8rem 0 rgba(0,0,0,0.1)
    use: Modal dialog, backdrop fade 0->0.5 black, min-height 264px
  badge-primary:
    type: badge
    backgroundColor: '#256ef4'
    textColor: '#ffffff'
    border: '1px solid #256ef4'
    rounded: 4px
    padding: 0 8px
    height: 24px
    typography: 15px / 400
    use: Content classification, action emphasis
  badge-point:
    type: badge
    backgroundColor: '#d63d4a'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 8px
    height: 24px
    typography: 15px / 400
    use: Emphasis/new/important (red point)
  badge-success:
    type: badge
    backgroundColor: '#228738'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 8px
    height: 24px
    typography: 15px / 400
    use: Completed / success
  badge-danger:
    type: badge
    backgroundColor: '#de3412'
    textColor: '#ffffff'
    rounded: 4px
    padding: 0 8px
    height: 24px
    typography: 15px / 400
    use: Error / rejected
  badge-warning:
    type: badge
    backgroundColor: '#ffb114'
    textColor: '#1e2124'
    rounded: 4px
    padding: 0 8px
    height: 24px
    typography: 15px / 400
    use: Caution (black text on warning bg)
  badge-tag:
    type: badge
    backgroundColor: '#ffffff'
    textColor: '#1e2124'
    border: '1px solid #cdd1d5'
    rounded: 1000px
    padding: 8px 10px
    typography: 15px / 400
    active: 'bg #ecf2fe fg #0b50d0 border #256ef4'
    use: Selectable filter chip with delete button
fonts:
  roles:
    sans: Pretendard GOV
---

# KRDS

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to KRDS; reproduced for educational reference. Full prose: https://oh-my-design.kr/krds/design.md
