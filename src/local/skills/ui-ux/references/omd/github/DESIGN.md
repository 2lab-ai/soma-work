---
name: GitHub
colors:
  primary: '#0969da'
  primary-dark: '#4493f8'
  accent-subtle: '#ddf4ff'
  success: '#1f883d'
  success-hover: '#1a7f37'
  success-subtle: '#dafbe1'
  danger: '#cf222e'
  danger-subtle: '#ffebe9'
  attention: '#9a6700'
  attention-emphasis: '#bf8700'
  attention-subtle: '#fff8c5'
  done: '#8250df'
  done-subtle: '#fbefff'
  sponsors: '#bf3989'
  canvas: '#ffffff'
  canvas-inset: '#f6f8fa'
  canvas-dark: '#0d1117'
  canvas-dark-inset: '#010409'
  canvas-dark-subtle: '#161b22'
  heading: '#1f2328'
  muted: '#59636e'
  subtle: '#818b98'
  on-emphasis: '#ffffff'
  text-dark: '#e6edf3'
  muted-dark: '#9198a1'
  border: '#d1d9e0'
  border-muted: '#d8dee4'
  border-dark: '#30363d'
  tab-active: '#fd8c73'
typography:
  page-title:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.25
    use: Repo/profile name, page title
  h1:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
    use: Section titles, settings headers
  h2:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    use: Card headers, sub-sections
  h3:
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.25
    use: List group headers, dialog titles
  body:
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.5
    use: The GitHub baseline — most UI text
  body-strong:
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.5
    use: File names, author names, emphasized labels
  small:
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.4
    use: Metadata, timestamps, counts, badges
  code:
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
    use: Mono — code, SHAs, paths, inline code
rounded:
  small: 3px
  medium: 6px
  large: 12px
  full: 9999px
spacing:
  xs: 4
  sm: 8
  base: 16
  lg: 24
  xl: 32
  xxl: 40
  xxxl: 48
components:
  button-primary:
    type: button
    backgroundColor: '#1f883d'
    textColor: '#ffffff'
    border: 1px solid rgba(31,35,40,0.15)
    rounded: 6px
    height: 32px
    padding: 0 16px
    typography: 14px / 600
    hover: 'bg #1a7f37'
    active: 'bg #187733'
    disabled: 'bg #94d3a2 · text 0.8 opacity'
    use: The one constructive primary action — Create/Commit/Merge. Never blue.
  button-default:
    type: button
    backgroundColor: '#f6f8fa'
    textColor: '#1f2328'
    border: '1px solid #d1d9e0'
    rounded: 6px
    height: 32px
    padding: 0 16px
    typography: 14px / 600
    hover: 'bg #eef1f4'
    active: 'bg #e6eaef'
    use: The most common neutral button — Cancel/Edit, secondary actions
  button-danger:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#cf222e'
    border: '1px solid #d1d9e0'
    rounded: 6px
    height: 32px
    hover: 'bg #cf222e · text #ffffff · border #cf222e'
    use: Destructive — Delete/Remove. Quiet until hovered, then commits to red.
  button-invisible:
    type: button
    backgroundColor: transparent
    textColor: '#0969da'
    border: none
    rounded: 6px
    height: 32px
    hover: 'bg #f6f8fa'
    use: Borderless tertiary — overflow triggers, icon buttons, in-row controls
  icon-button:
    type: button
    backgroundColor: transparent
    textColor: '#59636e'
    rounded: 6px
    height: 32px
    padding: '0'
    hover: 'bg #f6f8fa'
    use: Square icon-only control 28/32/40px, min 32x32 hit area — kebab menu, copy, bell
  button-sizes:
    type: button
    rounded: 6px
    states: small 28px / 12px / 0 12px · medium 32px / 14px / 0 16px · large 40px / 14px / 0 20px
    use: Button size scale (height · font · padding)
  text-input:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1f2328'
    border: '1px solid #d1d9e0'
    rounded: 6px
    height: 32px
    padding: 5px 12px
    typography: 14px / 400
    focus: 'border #0969da + shadow 0 0 0 3px rgba(9,105,218,0.3)'
    states: 'error border #cf222e + ring rgba(207,34,46,0.3) + #cf222e help text'
    use: 'Standard form field; placeholder #818b98'
  select:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#1f2328'
    border: '1px solid #d1d9e0'
    rounded: 6px
    focus: shadow 0 0 0 3px rgba(9,105,218,0.3)
    use: 'Native-backed dropdown styled as default input, trailing chevron #59636e'
  checkbox:
    type: toggle
    border: '1px solid #d1d9e0'
    rounded: 3px
    height: 16px
    active: 'checked #0969da fill + white check glyph'
    focus: shadow 0 0 0 3px rgba(9,105,218,0.3)
    use: 16px box; indeterminate shows a dash
  radio:
    type: toggle
    border: '1px solid #d1d9e0'
    rounded: 9999px
    height: 16px
    active: 'checked #0969da ring + filled #0969da dot'
    focus: shadow 0 0 0 3px rgba(9,105,218,0.3)
    use: 16px circle, mutually-exclusive option groups
  toggle-switch:
    type: toggle
    backgroundColor: '#818b98'
    rounded: 9999px
    active: 'on #1f883d'
    use: Settings boolean, ~32px pill track, white thumb with subtle shadow
  box:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#1f2328'
    border: '1px solid #d1d9e0'
    rounded: 6px
    padding: 16px
    shadow: none
    use: 'Canonical container, border-first. Optional #f6f8fa header + 1px bottom border. Repo rows, settings panels.'
  label:
    type: badge
    backgroundColor: '#ddf4ff'
    textColor: '#0969da'
    border: '1px solid #ddf4ff'
    rounded: 9999px
    height: 20px
    padding: 0 7px
    typography: 12px / 500
    use: Issue/PR tag tinted from its own hue at low alpha; ten color schemes
  counter-label:
    type: badge
    backgroundColor: rgba(175,184,193,0.2)
    textColor: '#1f2328'
    rounded: 9999px
    padding: 0 6px
    typography: 12px / 400
    use: Numeric pill, tabular — tab/notification/star counts
  state-label:
    type: badge
    backgroundColor: '#1f883d'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 4px 12px
    typography: 12px / 500
    states: 'open #1f883d · merged #8250df · closed #cf222e · draft #59636e'
    use: Large status pill atop an issue/PR, leading state icon
  token:
    type: badge
    backgroundColor: '#f6f8fa'
    textColor: '#1f2328'
    border: '1px solid #d1d9e0'
    rounded: 9999px
    use: Removable chip with trailing x — assignees, topics, applied labels
  avatar:
    type: avatar
    rounded: 9999px
    height: 20px
    use: Circular for people, 6px-radius square for orgs/teams/bots. Sizes 16-64px, default 20px.
  avatar-stack:
    type: avatar
    rounded: 9999px
    border: white ring between
    use: Overlapping circular avatars ~-8px overlap, collapsing a contributor list into a cluster
  action-list:
    type: listItem
    padding: 16px
    hover: 'bg #f6f8fa'
    active: 'selected bg #ddf4ff + text #0969da'
    use: Vertical list of actions in menus/panels; leading/trailing visuals, group headings, dividers, danger items
  action-menu:
    type: dialog
    backgroundColor: '#ffffff'
    border: '1px solid #d1d9e0'
    rounded: 6px
    shadow: 0 8px 24px rgba(31,35,40,0.2)
    use: An action-list rendered in an overlay popover — kebab overflow and dropdown menus
  underline-nav:
    type: tab
    border: '1px bottom border #d1d9e0'
    textColor: '#1f2328'
    typography: 14px / 400
    active: 'text #1f2328 600 + 2px bottom border #fd8c73'
    hover: 'bg #f6f8fa'
    use: Primary tab pattern (Code/Issues/PR/Actions, profile tabs); neutral counter pills
  segmented-control:
    type: tab
    backgroundColor: '#f6f8fa'
    border: '1px solid #d1d9e0'
    height: 32px
    active: 'selected white panel + 1px #d1d9e0 + small shadow'
    use: Pick one of a small linear set; sizes 28/32px; collapses to dropdown/hideLabels in tight space
  breadcrumbs:
    type: tab
    textColor: '#0969da'
    active: 'last crumb #1f2328 no-link'
    use: 'Inline path trail; #59636e slash separators. Repo file-path navigation.'
  pagination:
    type: tab
    textColor: '#0969da'
    rounded: 6px
    active: 'current page #0969da fill + #ffffff text'
    use: Numbered links with prev/next chevrons under long issue/commit lists
  tree-view:
    type: listItem
    hover: 'bg #f6f8fa'
    active: 'selected bg #ddf4ff'
    use: Indented file/symbol tree, 8px-step indentation, chevron disclosure on folders, keyboard-navigable
  dialog:
    type: dialog
    backgroundColor: '#ffffff'
    border: '1px solid #d1d9e0'
    rounded: 12px
    padding: 16px
    shadow: 0 8px 24px rgba(31,35,40,0.2)
    use: Modal; rgba(31,35,40,0.5) scrim, 16px header + 1px bottom border, title 16px / 600. Confirmation/delete prompts.
  overlay:
    type: dialog
    backgroundColor: '#ffffff'
    border: '1px solid #d1d9e0'
    rounded: 6px
    shadow: 0 3px 6px rgba(140,149,159,0.15)
    use: Floating-surface primitive (6-12px radius, medium/large shadow) — base for menus, popovers, dialogs
  tooltip:
    type: card
    backgroundColor: '#1f2328'
    textColor: '#ffffff'
    rounded: 6px
    padding: 6px 12px
    typography: 12px / 400
    use: Dark bubble with small directional arrow, on hover/focus, for icon-button labels and truncated text
  banner:
    type: card
    backgroundColor: '#ddf4ff'
    textColor: '#1f2328'
    border: 1px solid rgba(9,105,218,0.4)
    rounded: 6px
    padding: 16px
    states: 'info #ddf4ff · success #dafbe1 · warning #fff8c5 · critical #ffebe9'
    use: In-context message block, leading status icon + optional dismiss x; compact and flush layouts
  flash:
    type: card
    backgroundColor: '#ddf4ff'
    textColor: '#1f2328'
    rounded: 6px
    padding: 16px
    states: 'info #ddf4ff · success #dafbe1 · warning #fff8c5 · critical #ffebe9'
    use: Page-level banner spanning content width at page top; persists until navigation
  inline-message:
    type: card
    textColor: '#1a7f37'
    states: 'success #1a7f37 · attention #9a6700 · danger #cf222e'
    use: Compact single-line status beside a control, leading icon + tone-colored text — validation hints
  spinner:
    type: card
    textColor: '#59636e'
    use: Indeterminate circular loader, ~1.5px stroke, sizes 16/24/32/48px; replaces a button label during long ops
  progress-bar:
    type: card
    backgroundColor: '#d1d9e0'
    textColor: '#1f883d'
    rounded: 9999px
    height: 8px
    use: Rounded full track with green fill — language-breakdown bars, upload/operation progress
  skeleton:
    type: card
    backgroundColor: '#f6f8fa'
    rounded: 6px
    use: Loading placeholders at final element geometry, subtle shimmer; SHAs/counts render as skeleton bars not values
  blankslate:
    type: card
    textColor: '#1f2328'
    use: 'Centered empty state — icon visual, #1f2328 heading, #59636e description, green primary action + optional secondary link; narrow/spacious/bordered variants'
  timeline:
    type: listItem
    border: '#d1d9e0 vertical rail'
    use: 'Issue/PR activity thread; badge nodes (commit/comment/label/merge) and avatar-led rows. Merge event in #8250df done purple.'
  branch-name:
    type: badge
    backgroundColor: '#ddf4ff'
    textColor: '#0969da'
    rounded: 6px
    padding: 0 6px
    typography: mono
    use: Inline branch/ref reference in monospace
fonts:
  roles:
    ui: '-apple-system, BlinkMacSystemFont, Segoe UI, Noto Sans, Helvetica, Arial, sans-serif'
    mono: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace
    marketing: Mona Sans, Hubot Sans
---

# GitHub

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to GitHub; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/github/DESIGN.md
