---
name: Qiita
colors:
  brand: '#55c500'
  team-blue: '#4097db'
  green-text: '#357a00'
  green-90: '#2b6300'
  green-70: '#4cb100'
  green-20: '#dff4cf'
  green-container-dim: '#2b6300'
  blue-text: '#2c6897'
  blue-text-dim: '#204c6e'
  blue-70: '#3987c4'
  blue-50: '#7bb7e6'
  blue-30: '#c0ddf3'
  red-container: '#bd0505'
  red-90: '#6d0303'
  red-30: '#ffb8b8'
  yellow-70: '#ae8803'
  yellow-container-dim: '#685103'
  bronze-text: '#663700'
  bronze-container: '#ffdcb3'
  canvas: '#ffffff'
  gray-10: '#f5f6f6'
  gray-20: '#edeeee'
  gray-30: '#dfe0e0'
  ink-muted: '#494b4b'
  social-twitter: '#000000'
  social-github: '#1a1414'
  social-hatena-blog: '#333333'
  partner-findy: '#155aa8'
  partner-findy-dim: '#003d83'
typography:
  body-3:
    fontSize: 12px
    use: '--font-size-body-3; metadata and tag labels'
  body-2:
    fontSize: 14px
    use: '--font-size-body-2; the control label size'
  body-1:
    fontSize: 16px
    use: '--font-size-body-1; the dominant rendered size, 908 of 1,999 elements'
  subhead-2:
    fontSize: 18px
    use: '--font-size-subhead-2'
  subhead-1:
    fontSize: 20px
    use: '--font-size-subhead-1'
  headline-2:
    fontSize: 24px
    use: '--font-size-headline-2'
  headline-1:
    fontSize: 32px
    use: '--font-size-headline-1; the largest published step'
rounded:
  sm: 4px
  md: 8px
  pill: 21px
  circle: 9999px
components:
  button-primary:
    type: button
    backgroundColor: '#357a00'
    textColor: '#ffffff'
    rounded: 8px
    height: 34px
    typography: 14px / 600
    hover: '#2b6300'
    pressed: '#2b6300'
    use: The filled call to action, 88×34. Hover and pressed both step to green90; the label does not move.
  button-outline:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#357a00'
    border: '1px solid #357a00'
    rounded: 8px
    height: 34px
    typography: 14px / 600
    hover: '#f5f6f6'
    pressed: '#f5f6f6'
    use: The outline twin at the same height, 87×34 — green on white. Hover and pressed wash to gray10.
  button-outline-neutral:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#494b4b'
    border: '1px solid #494b4b'
    rounded: 8px
    height: 34px
    typography: 14px / 600
    hover: '#f5f6f6'
    pressed: '#f5f6f6'
    use: The same outline component in grey, 108×34, used where the pair's emphasis is reversed.
  chip-topic:
    type: button
    backgroundColor: '#edeeee'
    textColor: rgba(0,0,0,.6)
    rounded: 4px
    typography: 12px / 400
    hover: '#dfe0e0'
    pressed: '#dfe0e0'
    use: A topic tag (AI, 入門). Hover and pressed step one rung down the grey ramp, gray20 to gray30.
  pill-filter:
    type: button
    backgroundColor: '#ffffff'
    textColor: rgba(0,0,0,.87)
    border: 1px solid rgba(0,0,0,.12)
    rounded: 21px
    height: 39px
    hover: '#edeeee'
    pressed: '#edeeee'
    use: The feed filter (すべて), 156×39 — the only 21px radius on the page, and the only control with a divider-coloured border.
  button-icon:
    type: button
    backgroundColor: transparent
    textColor: rgba(0,0,0,.87)
    rounded: 9999px
    height: 44px
    hover: '#edeeee'
    pressed: '#edeeee'
    use: A circular icon action (more_horiz), 44×44, transparent until hovered.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# Qiita

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Qiita; reproduced for educational reference. Full prose: https://oh-my-design.kr/qiita/design.md
