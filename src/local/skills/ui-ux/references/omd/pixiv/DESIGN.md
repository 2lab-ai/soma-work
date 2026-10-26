---
name: pixiv
colors:
  primary: '#0096fa'
  primary-hover: '#0086e0'
  primary-ui-hover: '#0090f0'
  primary-pressed: '#007ed2'
  primary-faded: '#99d7ff'
  canvas: '#ffffff'
  surface: '#f5f5f5'
  surface-pressed: '#d6d6d6'
  foreground: '#1f1f1f'
  text-muted: '#474747'
  text-tertiary: '#858585'
  text-disabled: '#adadad'
  on-primary: '#ffffff'
  engagement-red: '#ff4060'
  success: '#b1cc29'
  warning: '#ffaf0f'
  error: '#ff2b00'
  link: '#3d7699'
  link-hover: '#336481'
  dark-canvas: '#1f1f1f'
  dark-elevated: '#3a3a3a'
  dark-text: '#f5f5f5'
  dark-text-muted: '#d6d6d6'
typography:
  heading-xxxl:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 40
    use: Largest published heading role
  heading-xxl:
    fontSize: 28px
    fontWeight: 700
    lineHeight: 36
    use: Page-level heading
  heading-xl:
    fontSize: 25px
    fontWeight: 700
    lineHeight: 32
    use: Section heading
  heading-l:
    fontSize: 22px
    fontWeight: 700
    lineHeight: 28
    use: Sub-section heading
  heading-m:
    fontSize: 20px
    fontWeight: 700
    lineHeight: 28
    use: Card / panel heading
  heading-s:
    fontSize: 18px
    fontWeight: 700
    lineHeight: 24
    use: Dense heading
  heading-xs:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 24
    use: Smallest heading role
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22
    use: Standard reading text
  paragraph:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22
    use: Running paragraph text
  caption-m:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 22
    use: Caption, medium
  caption-s:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 20
    use: Metadata, counts, timestamps
rounded:
  sm: 4px
  lg: 16px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  md: 12
  base: 16
  lg: 24
  xl: 32
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0096fa'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 0 24px
    typography: 14px / 700
    hover: '#0090f0'
    pressed: '#007ed2'
    focus: '#0096fa'
    use: Primary CTA — 40px tall, fully oval; focus adds a 4px brand-blue halo at 32%.
  button-default:
    type: button
    textColor: '#474747'
    rounded: 9999px
    padding: 0 24px
    typography: 14px / 700
    hover: rgba(0,0,0,0.08)
    pressed: rgba(0,0,0,0.192)
    focus: '#0096fa'
    use: Neutral action on a translucent black fill (4% at rest); 40px tall, oval; the same 4px brand-blue focus halo.
  icon-button:
    type: button
    textColor: '#858585'
    rounded: 9999px
    typography: 16px / 400
    hover: '#f5f5f5'
    pressed: '#d6d6d6'
    focus: '#0096fa'
    use: Icon-only action, 40px square, transparent at rest; the same 4px brand-blue focus halo.
  switch:
    type: toggle
    backgroundColor: '#858585'
    rounded: 9999px
    hover: '#808080'
    pressed: '#707070'
    focus: '#0096fa'
    use: Settings switch — 16px track; focus turns it brand blue.
  checkbox:
    type: toggle
    rounded: 4px
    border: '2px solid #858585'
    focus: '#0096fa'
    use: Checkbox — 20px box; focus fills brand blue and drops the border.
  tag-item:
    type: badge
    textColor: '#ffffff'
    rounded: 4px
    padding: 4px 24px
    typography: 16px / 400
    use: Tag pill — 40px tall; fill varies by tag category.
fonts:
  roles:
    sans: Noto Sans CJK JP
  faces:
    Noto Sans CJK JP:
      evidence:
        - declared-only
      source: https://github.com/notofonts/noto-cjk
      licence: OFL-1.1
      distribution: public
      note: Charcoal's sans token names it; Charcoal component stories compute Noto Sans JP and pixiv.net body text resolves to the OS UI font.
---

# pixiv

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to pixiv; reproduced for educational reference. Full prose: https://oh-my-design.kr/pixiv/design.md
