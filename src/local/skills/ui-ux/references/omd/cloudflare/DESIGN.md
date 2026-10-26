---
name: Cloudflare
colors:
  primary: '#F6821F'
  primary-hover: '#E2700B'
  primary-pressed: '#D9700F'
  brand: '#F6821F'
  brand-gradient-end: '#FAAD3F'
  canvas: '#FFFFFF'
  surface: '#FFFFFF'
  surface-alt: '#F7F7F7'
  foreground: '#1D1F20'
  body: '#36393A'
  muted: '#717174'
  placeholder: '#999999'
  hairline: '#EDEDED'
  border-strong: '#D9D9D9'
  on-primary: '#FFFFFF'
  orange-tint: '#FDF3E7'
  success: '#2FB344'
  error: '#BD2528'
  warning: '#F6C549'
  info: '#2C7CB0'
  dark-bg: '#15171A'
  dark-surface: '#262A2E'
  dark-border: '#3A3F44'
  dark-text: '#E4E6E7'
typography:
  display-hero:
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.02px'
    use: Marketing hero headline
  display:
    fontSize: 40px
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: '-0.02px'
    use: Major section headers
  heading-1:
    fontSize: 32px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: '-0.01px'
    use: Page titles
  heading-2:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.01px'
    use: Section / card group titles
  heading-3:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    use: Card headings, panel titles
  subtitle:
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.45
    use: Lead-in / dashboard section labels
  body-large:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    use: Marketing paragraphs
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
    use: Dashboard standard text
  body-small:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
    use: Table cells, secondary info
  caption:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    use: Metadata, timestamps, helper text
  label-eyebrow:
    fontSize: 12px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.06px
    use: Section eyebrows, table headers, uppercase
  code-mono:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.6
    use: DNS records, IPs, API tokens, code
rounded:
  sm: 4px
  md: 6px
  lg: 8px
  xl: 12px
  full: 9999px
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
    backgroundColor: '#f6821f'
    textColor: '#ffffff'
    rounded: 8px
    height: 36px
    padding: 0 12px
    typography: 14px / 600
    hover: '#e2700b'
    active: '#d9700f'
    focus: 2px brand ring
    disabled: brand 50% opacity
    use: Primary action — Get started, Add site, Save, Deploy
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#36393a'
    border: '1px solid #d9d9d9'
    rounded: 8px
    hover: 'bg #fafafa · border #a1a1a1'
    use: Companion to a primary — Cancel, Back
  button-ghost:
    type: button
    backgroundColor: transparent
    textColor: '#f6821f'
    rounded: 8px
    padding: 0 12px
    hover: 'bg #fdf3e7'
    use: Inline low-emphasis action, Learn more, text-link button
  button-danger:
    type: button
    backgroundColor: '#bd2528'
    textColor: '#ffffff'
    rounded: 8px
    hover: '#a11f22'
    use: Delete zone, remove record, purge — confirmation contexts only
  button-sm:
    type: button
    height: 26px
    rounded: 6px
    padding: 0 8px
    typography: 12px / 600
    use: Toolbar and table-row inline actions where vertical space is tight
  icon-button:
    type: button
    height: 36px
    rounded: 8px
    padding: '0'
    use: Close, kebab menu, copy-to-clipboard affordance
  input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1d1f20'
    border: '1px solid #d9d9d9'
    rounded: 8px
    height: 40px
    padding: 0 16px
    typography: 14px / 400
    focus: 1.5px brand ring · 0 0 0 3px rgba(246,130,31,0.2)
    use: Standard form input, search, config values
  input-mono:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1d1f20'
    border: '1px solid #d9d9d9'
    rounded: 8px
    typography: 13px / 400 JetBrains Mono
    use: DNS record values, IP entry, token paste fields
  select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1d1f20'
    border: '1px solid #d9d9d9'
    rounded: 8px
    height: 40px
    use: 'Plan picker, record-type selector, region dropdown — #717174 chevron'
  switch:
    type: toggle
    active: '#f6821f'
    disabled: '#d9d9d9'
    rounded: 5px
    use: Proxy on/off, feature flags, security toggles — white thumb with edge+drop shadow
  checkbox:
    type: toggle
    backgroundColor: '#f6821f'
    border: '1px solid #d9d9d9'
    rounded: 6px
    use: Multi-select rules, plan options, consent — brand fill + white glyph when checked
  card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #ededed'
    rounded: 8px
    padding: 24px
    shadow: 0 1px 3px rgba(0,0,0,0.06)
    use: Dashboard config panels, analytics modules — the workhorse surface
  stat-card:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #ededed'
    rounded: 8px
    padding: 20px
    typography: '32px / 700 #1d1f20 number · 12px / 600 uppercase #717174 label'
    use: Analytics summary tiles (requests, bandwidth, threats blocked)
  surface:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #ededed'
    use: 'kumo elevation roles — canvas #ffffff, recessed #f7f7f7, line/hairline #ededed'
  badge:
    type: badge
    rounded: 9999px
    padding: 2px 8px
    typography: 12px / 500
    use: NEW, Beta, version, plan, short metadata — neutral/success/error/warning/info/orange + dashed-brand + 7px status dot
  status-pill:
    type: badge
    backgroundColor: '#e8f5d8'
    textColor: '#3d6b14'
    rounded: 9999px
    padding: 2px 10px
    typography: 12px / 600
    states: 'green active #e8f5d8/#3d6b14 · red down #fbe2e2/#bd2528 · yellow pending #fcf3d6/#8a6d1b · grey #ededed/#4d4d4d · orange #fdf3e7/#c2670f'
    use: Active, Proxied, Down, Pending status with colored dot
  tabs:
    type: tab
    active: 'text #1d1f20 + 2px bottom border #f6821f'
    border: '1px solid #ededed bottom rule'
    typography: 14px / 600
    disabled: '#717174 inactive label'
    use: Dashboard section switching (Overview / Analytics / DNS / SSL)
  table:
    type: card
    backgroundColor: '#ffffff'
    border: '1px solid #ededed'
    typography: '13px / 400 #36393a body'
    padding: 12px 16px
    hover: '#fafafa row'
    use: 'DNS records, firewall rules, analytics logs — header bg #fafafa 12px/600 uppercase #717174'
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    textColor: '#1d1f20'
    border: '1px solid #ededed'
    rounded: 12px
    padding: 32px
    shadow: 0 12px 32px rgba(0,0,0,0.18)
    use: Confirmations, destructive double-checks, add-record flows — scrim rgba(29,31,32,0.5), scale-90 enter over 150ms
  toast:
    type: toast
    backgroundColor: '#1d1f20'
    textColor: '#ffffff'
    rounded: 12px
    padding: 16px
    shadow: 0 8px 24px rgba(0,0,0,0.12)
    states: 'success #2fb344 · error #bd2528 · warning #f6c549 · info #2c7cb0'
    use: Auto-dismissing confirmation, fixed bottom-right 340px, 4-5s dismiss
  tooltip:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1d1f20'
    border: '1px solid #ededed'
    rounded: 6px
    padding: 6px 10px
    typography: 13px / 400
    shadow: shadow-lg
    use: Icon labels, truncated-value reveal, glossary terms
  code-block:
    type: card
    backgroundColor: '#f5f5f5'
    textColor: '#1d1f20'
    border: '1px solid #ededed'
    rounded: 6px
    padding: 12px 16px
    typography: 13px / 400 JetBrains Mono
    use: API examples, Worker snippets, curl commands, DNS values
fonts:
  roles:
    sans: Inter
    mono: JetBrains Mono
---

# Cloudflare

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Cloudflare; reproduced for educational reference. Full prose: https://oh-my-design.kr/cloudflare/design.md
