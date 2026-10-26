---
name: Coinbase
colors:
  primary: '#0052ff'
  primary-hover: '#578bfa'
  brand: '#0052ff'
  canvas: '#ffffff'
  foreground: '#0a0b0d'
  muted: '#5b616e'
  on-primary: '#ffffff'
  surface: '#eef0f3'
  surface-dark: '#282b31'
  dark-section: '#0a0b0d'
  link: '#0667d0'
typography:
  display-hero:
    fontSize: 80px
    fontWeight: 400
    lineHeight: 1
    use: Hero headlines, maximum impact
  display-secondary:
    fontSize: 64px
    fontWeight: 400
    lineHeight: 1
    use: Sub-hero headlines
  display-third:
    fontSize: 52px
    fontWeight: 400
    lineHeight: 1
    use: Third-tier display
  section-heading:
    fontSize: 36px
    fontWeight: 400
    lineHeight: 1.11
    use: Feature section titles
  card-title:
    fontSize: 32px
    fontWeight: 400
    lineHeight: 1.13
    use: Card headings
  feature-title:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.33
    use: Feature emphasis
  body-bold:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.5
    use: Strong body
  body-semibold:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.25
    use: Buttons, nav
  body:
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.56
    use: Standard reading
  body-small:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
    use: Secondary reading
  button:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: 0.16px
    use: Button labels
  caption:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: Metadata
  small:
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.23
    use: Tags
rounded:
  sm: 4px
  md: 8px
  lg: 16px
  xl: 40px
  pill: 56px
  full: 100000px
spacing:
  xs: 4
  sm: 8
  md: 16
  base: 16
  lg: 24
  xl: 32
  xxl: 48
  section: 64
components:
  button-primary:
    type: button
    backgroundColor: '#0052ff'
    textColor: '#ffffff'
    rounded: 100000px
    border: '1px solid #0052ff'
    typography: 16px / 600
    hover: 'bg #578bfa'
    focus: 2px solid black outline
    states: loading hides label + ProgressCircle · sizes Compact/Default/Block
    use: High-emphasis primary CTA, one per screen
  button-secondary:
    type: button
    backgroundColor: '#eef0f3'
    textColor: '#0a0b0d'
    rounded: 100000px
    border: '1px solid #eef0f3'
    typography: 16px / 600
    use: Medium-emphasis equal-weight actions
  button-tertiary:
    type: button
    backgroundColor: '#eef0f3'
    textColor: '#0a0b0d'
    rounded: 100000px
    states: transparent-until-interaction
    use: Low-emphasis action
  button-inverse:
    type: button
    backgroundColor: '#282b31'
    textColor: '#ffffff'
    rounded: 100000px
    use: High contrast on dark sections
  button-negative:
    type: button
    textColor: '#ffffff'
    rounded: 100000px
    use: Destructive only, used sparingly
  button-transparent:
    type: button
    backgroundColor: transparent
    textColor: '#0a0b0d'
    rounded: 100000px
    states: container visible only on hover/press · sizes Compact/Default/Block · startIcon+endIcon slots
    use: Transparent modifier on any variant
  button-blue-bordered:
    type: button
    backgroundColor: transparent
    textColor: '#0052ff'
    rounded: 100000px
    border: '1px solid #0052ff'
    typography: 16px / 600
    use: Secondary CTA pairing
  icon-button:
    type: button
    backgroundColor: transparent
    rounded: 100000px
    height: 56px
    use: Icon-only action, 56px round hit-target
  chip:
    type: badge
    backgroundColor: '#eef0f3'
    textColor: '#0a0b0d'
    rounded: 100000px
    states: 'selected bg #0052ff'
    use: Pill selectable token
  nav-tab-chip:
    type: tab
    textColor: '#0667d0'
    rounded: 16px
    padding: 4px 16px
    typography: 14px / 400
    use: Header category chip
  text-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#0a0b0d'
    border: 1px solid rgba(91,97,110,0.2)
    rounded: 8px
    height: 56px
    padding: 16px
    typography: 16px / 400
    states: 'label outside/inside-float · negative sets aria-invalid + ''Error: …'' helper · positive validated · read-only secondary bg · disabled distinct'
    use: Bordered text field
  search-input:
    type: input
    backgroundColor: transparent
    textColor: '#0a0b0d'
    border: none
    typography: 16px / 400
    states: borderless inline · leading search glyph
    use: Inline search field
  switch:
    type: toggle
    states: 'control #0052ff when checked · optional thumb elevation'
    use: On/off toggle
  checkbox-radio:
    type: toggle
    active: 'selected fill #0052ff'
    states: Cell + Group wrappers
    use: Checkbox and Radio selection
  segmented-control:
    type: tab
    backgroundColor: '#eef0f3'
    active: 'active segment #0052ff'
    rounded: 100000px
    use: Time-range and view switches
  card:
    type: card
    backgroundColor: '#ffffff'
    border: 1px solid rgba(91,97,110,0.2)
    rounded: 8px–40px
    shadow: none — depth from section contrast
    states: ContentCard Header/Body/Footer · DataCard/MediaCard/NudgeCard/UpsellCard
    use: Content container family
  data-table:
    type: card
    border: 1px solid rgba(91,97,110,0.2)
    states: desktop-only (Lists View on mobile) · variants default/graph/ruled · required header row · sortable · sticky header · TableCellFallback skeleton
    use: Tabular data, desktop only
  list-cell:
    type: listItem
    textColor: '#0a0b0d'
    states: leading CellMedia + title/subtitle
    use: Mobile substitute for Table, asset rows
  modal:
    type: dialog
    backgroundColor: '#ffffff'
    shadow: scrim overlay + FocusTrap
    states: visible + onRequestClose · restoreFocusOnUnmount=false for chains · FullscreenModal/Tray/Alert/FullscreenAlert siblings
    use: Header/Body/Footer modal
  toast:
    type: toast
    states: bottom-anchored · auto-dismiss 5s base + close button · bgPositive/bgNegative/bgWarning · role=alert · persists on hover
    use: Transient status message
  tooltip:
    type: card
    states: Tooltip + PopoverPanel + Coachmark
    use: Contextual hints and first-run tours
  banner:
    type: card
    border: global avoids custom radius — flush with status bar
    states: styles global/inline/contextual · variants informational/warning/error/promotional · startIcon+title+children+primaryAction+secondaryAction+showDismiss
    use: Feedback and status messaging
  progress:
    type: card
    textColor: '#0052ff'
    states: ProgressCircle determinate 0–100% / indeterminate fgMuted arc · stroke thin 2px/normal 4px/semiheavy 8px/heavy 12px · ProgressBar + Spinner
    use: Determinate/indeterminate progress
  sparkline:
    type: card
    textColor: '#0052ff'
    states: Sparkline/LineChart/AreaChart/BarChart/PercentageBarChart · live price ticks flash green/red (disabled under reduced-motion)
    use: Inline price/chart visualization
  dark-section:
    type: card
    backgroundColor: '#0a0b0d'
    textColor: '#ffffff'
    active: 'accent links #0052ff'
    use: Dark feature section
fonts:
  roles:
    sans: CoinbaseSans
    display: CoinbaseDisplay
    body: CoinbaseText
    icon: CoinbaseIcons
---

# Coinbase

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Coinbase; reproduced for educational reference. Full prose: https://oh-my-design.kr/coinbase/design.md
