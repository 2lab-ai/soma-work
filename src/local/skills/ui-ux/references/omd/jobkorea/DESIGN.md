---
name: JobKorea
colors:
  primary: '#083ccc'
  primary-hover: '#012ca2'
  primary-500: '#1b55f6'
  primary-400: '#4c7afb'
  primary-50: '#f0f2fa'
  point-orange: '#ff6d12'
  text: '#1a1a1e'
  text-secondary: '#292c32'
  text-tertiary: '#575f6c'
  placeholder: '#949ba8'
  border: '#e6e8ea'
  canvas: '#f6f7f8'
  error: '#fc3b3b'
  success: '#0dbc7c'
  white: '#ffffff'
typography:
  display:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: '-0.5px'
    use: Display 1
  h1:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.31
    letterSpacing: '-0.5px'
    use: H1 heading
  h4:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    use: H4 sub-heading
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Body 2 reading text
  caption:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.38
    use: Caption 1
rounded:
  sm: 4px
  md: 10px
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
  button-primary:
    type: button
    backgroundColor: '#083ccc'
    textColor: '#ffffff'
    rounded: 10px
    padding: 0 16px
    typography: 16px weight 700
    use: 'Primary CTA, 48px tall, hover #012ca2'
  chip-selected:
    type: badge
    backgroundColor: '#f0f2fa'
    textColor: '#083ccc'
    use: Selected chip / brand-tinted pill tag fill
  badge-urgent:
    type: badge
    textColor: '#ff6d12'
    use: Urgency badge, deadline label
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1a1a1e'
    border: '#e6e8ea'
    use: Default input, gray border
  card:
    type: card
    backgroundColor: '#ffffff'
    border: '#e6e8ea'
    use: Job-listing card surface, subtle elevation
  badge-error:
    type: badge
    textColor: '#fc3b3b'
    use: Form error / destructive indicator
  badge-success:
    type: badge
    textColor: '#0dbc7c'
    use: Application success / offer received
fonts:
  roles:
    sans: Pretendard
    fallback: Apple SD Gothic Neo, Malgun Gothic, sans-serif
---

# JobKorea

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to JobKorea; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/jobkorea/DESIGN.md
