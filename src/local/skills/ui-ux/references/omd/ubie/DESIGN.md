---
name: Ubie
colors:
  primary: '#3959cc'
  primary-hover: '#283f91'
  accent: '#27cc91'
  canvas: '#ffffff'
  text-main: '#32353a'
  text-sub: '#686a6d'
  placeholder: '#96989a'
  disabled: '#dcdddd'
  border: '#c5c6c7'
  border-light: '#dcdddd'
  surface-subtle: '#fafafa'
  error: '#e32e55'
  error-text: '#a1213c'
  error-bg: '#fceff2'
  success-text: '#1c9167'
  success-bg: '#e9faf4'
  info-bg: '#f0f2fc'
  info-border: '#8296df'
  on-primary: '#ffffff'
typography:
  heading-xl:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.4
    use: Page hero, landing titles
  heading-lg:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.4
    use: Major section titles
  heading-md:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.4
    use: Section headers
  heading-sm:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 1.5
    use: Card titles, modal headers
  heading-xs:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: List headers, sub-sections
  body-lg:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.7
    use: Primary reading text
  body-md:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.7
    use: Standard body, descriptions
  note:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Captions, helper text
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1
    use: Action labels
  tag:
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1
    use: Category chips, status keywords
rounded:
  sm: 4px
  md: 8px
  lg: 12px
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
  button-primary:
    type: button
    backgroundColor: '#3959cc'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 24px
    typography: 16px/700
    hover: '#283f91'
    disabled: '#f6f6f6'
    focus: '#e1568a'
    use: Single most important action
  button-accent:
    type: button
    backgroundColor: '#27cc91'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 24px
    use: Health-forward emphasis. Documented in the design docs; no accent variant was found in the shipped component CSS read 2026-09-16, so its states are unresolved.
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#3959cc'
    rounded: 8px
    padding: 12px 24px
    hover: '#f6f6f6'
    disabled: '#f6f6f6'
    focus: '#5d77d5'
    use: 'Subordinate action; 1px #3959cc border'
  button-alert:
    type: button
    backgroundColor: '#e32e55'
    textColor: '#ffffff'
    rounded: 8px
    padding: 12px 24px
    hover: '#a1213c'
    disabled: '#f6f6f6'
    focus: '#5d77d5'
    use: Irreversible/risky actions
  button-text:
    type: button
    backgroundColor: transparent
    textColor: '#3959cc'
    rounded: 8px
    padding: 8px 12px
    typography: 14px/700
    hover: '#f0f2fc'
    focus: '#5d77d5'
    use: Low-emphasis inline action
  textfield:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#32353a'
    rounded: 8px
    padding: 12px 16px
    typography: 16px
    focus: '#5d77d5'
    disabled: '#f6f6f6'
    use: 'Standard input; 1px #c5c6c7 border, focus #3959cc'
  textfield-error:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#32353a'
    rounded: 8px
    padding: 12px 16px
    error: '#e85474'
    use: 'Validation failure; 1px #e32e55 border, help #a1213c'
  card:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 24px
    use: 'Symptom result / content panel; 1px #dcdddd border'
  card-interactive:
    type: card
    backgroundColor: '#ffffff'
    rounded: 12px
    padding: 16px
    hover: '#f0f2fc'
    disabled: '#f6f6f6'
    use: 'Tappable card; 1px #dcdddd border, hover #8296df'
  card-tinted:
    type: card
    backgroundColor: '#f0f2fc'
    rounded: 8px
    padding: 16px
    use: Inline informational callout
fonts:
  roles:
    sans: A P-OTF UD Shin Go Pr6N
    mono: Open Sans
---

# Ubie

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Ubie; reproduced for educational reference. Full prose: https://oh-my-design.kr/ubie/design.md
