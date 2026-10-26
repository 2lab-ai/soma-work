---
name: GitLab
colors:
  primary: '#1f75cb'
  primary-border: '#2f68b4'
  brand-orange: '#fc6d26'
  duo-purple: '#7759c2'
  ink: '#171321'
  ink-strong: '#18171d'
  text-default: '#28272d'
  text-primary: '#3a383f'
  muted: '#74717a'
  muted-alt: '#626168'
  faint: '#4c4b51'
  canvas: '#ffffff'
  surface: '#f4f4f4'
  surface-tint: '#f2f1f5'
  purple-tint: '#f6f3fe'
  dark-surface: '#1f1c2e'
  dark-deep: '#060a0f'
  hairline: '#bfbfc3'
  hairline-soft: '#dcdcde'
  on-primary: '#ffffff'
  danger: '#dd2b0e'
  danger-border: '#c02f12'
  danger-text: '#a32c12'
  danger-tint: '#fdd4cd'
  success-tint: '#c3e6cd'
  success-text: '#306440'
  warning-tint: '#f5d9a8'
  warning-text: '#894b16'
  info-tint: '#cbe2f9'
  info-text: '#2f5ca0'
  tier-tint: '#e1d8f9'
  tier-text: '#5c47a6'
typography:
  display-hero:
    fontSize: 96px
    fontWeight: 660
    lineHeight: 1.04
    letterSpacing: '-2.88px'
    use: Hero headline, GitLab Sans semibold
  section:
    fontSize: 32px
    fontWeight: 660
    lineHeight: 1.12
    letterSpacing: '-0.64px'
    use: Section titles
  subsection:
    fontSize: 18px
    fontWeight: 660
    lineHeight: 1.33
    use: Card / nav-card heads, CTA labels
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Standard reading text
  ui:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
    use: Component / docs UI text, Pajamas default
  badge:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
    use: Pill badge label
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
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-confirm:
    type: button
    backgroundColor: '#1f75cb'
    textColor: '#ffffff'
    border: '1px solid #2f68b4'
    rounded: 8px
    height: 32px
    padding: 0 12px
    typography: 14px / 400 GitLab Sans
    use: Primary confirm action (Pajamas), hover darkens
  button-danger:
    type: button
    backgroundColor: '#dd2b0e'
    textColor: '#ffffff'
    border: '1px solid #c02f12'
    rounded: 8px
    height: 32px
    padding: 0 12px
    typography: 14px / 400 GitLab Sans
    use: Destructive action
  button-default:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3a383f'
    border: '1px solid #bfbfc3'
    rounded: 8px
    height: 32px
    padding: 0 12px
    typography: 14px / 400 GitLab Sans
    use: Secondary/default action
    states: 'selected #ececef · disabled bg #fbfafd fg #74717a'
  button-marketing:
    type: button
    backgroundColor: '#171321'
    textColor: '#ffffff'
    rounded: 4px
    height: 47px
    padding: 11px 16px
    typography: 18px / 660 GitLab Sans
    use: Marketing ink CTA on about.gitlab.com — Get free trial / Try for free
  input-text:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#3a383f'
    rounded: 8px
    padding: 8px 12px
    height: 32px
    typography: 14px GitLab Sans
    shadow: '0 0 0 1px inset #89888d'
    use: 'Pajamas form input, focus blue #1f75cb ring'
  nav-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#171321'
    rounded: 16px
    padding: 24px
    use: Homepage product nav / feature card on dark band
  dark-stat-card:
    type: card
    backgroundColor: '#1f1c2e'
    textColor: '#ffffff'
    rounded: 16px
    padding: 32px
    use: Dark proof-stat card (4 hours saved, 82% decrease)
  badge-info:
    type: badge
    backgroundColor: '#cbe2f9'
    textColor: '#2f5ca0'
    rounded: 160px
    padding: 2px 6px
    typography: 12px / 400 GitLab Sans
    use: Info pill (Pajamas badge)
  badge-success:
    type: badge
    backgroundColor: '#c3e6cd'
    textColor: '#306440'
    rounded: 160px
    padding: 2px 6px
    typography: 12px / 400 GitLab Sans
    use: Success pill
  badge-danger:
    type: badge
    backgroundColor: '#fdd4cd'
    textColor: '#a32c12'
    rounded: 160px
    padding: 2px 6px
    typography: 12px / 400 GitLab Sans
    use: Danger pill
  badge-tier:
    type: badge
    backgroundColor: '#e1d8f9'
    textColor: '#5c47a6'
    rounded: 160px
    padding: 2px 6px
    typography: 12px / 400 GitLab Sans
    use: Tier / plan pill (purple)
fonts:
  roles:
    sans: GitLab Sans
---

# GitLab

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to GitLab; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/gitlab/DESIGN.md
