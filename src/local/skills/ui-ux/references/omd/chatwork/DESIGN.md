---
name: Chatwork
colors:
  brand: '#f03748'
  link: '#df1c13'
  secondary: '#645b4a'
  foreground: '#13202f'
  ink: '#191919'
  muted: '#949aa2'
  canvas: '#ffffff'
typography:
  xsmall:
    fontSize: 10px
    use: '--rise--fontSize-other-xSmall, .625rem'
  caption:
    fontSize: 12px
    use: '--rise--fontSize-caption, .75rem — and the most common rendered size, on 105 elements'
  body2:
    fontSize: 14px
    use: '--rise--fontSize-body2 and -button-small, .875rem'
  body1:
    fontSize: 16px
    use: '--rise--fontSize-body1 and -button-medium, 1rem'
  subtitle:
    fontSize: 20px
    use: '--rise--fontSize-subtitle and -button-large, 1.25rem'
  headline3:
    fontSize: 24px
    use: '--rise--fontSize-headline3, 1.5rem'
  headline2:
    fontSize: 32px
    use: '--rise--fontSize-headline2, 2.0rem'
  headline1:
    fontSize: 40px
    use: '--rise--fontSize-headline1, 2.5rem'
  other-large:
    fontSize: 48px
    use: '--rise--fontSize-other-large, 3rem — the largest published step'
rounded:
  sm: 5px
  md: 6px
  lg: 15px
  xl: 20px
  pill: 50px
components:
  button-cta:
    type: button
    backgroundColor: '#f03748'
    textColor: '#ffffff'
    rounded: 50px
    height: 60px
    typography: 17px / 700
    hover: '#f03748'
    pressed: '#f03748'
    use: The primary call to action (無料登録して使う) — a 50px pill repeated at 35, 60, 80 and 85px tall. Measured across hover and pressed with :hover live; neither changes anything.
    padding: 0px
  button-outline-red:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#df1c13'
    rounded: 50px
    height: 42px
    typography: 14px / 400
    hover: '#645b4a'
    pressed: '#645b4a'
    use: 'White 50px pill with the link red as text and no border at all. Hover and pressed move the text to #645b4a, the system''s olive secondary.'
  link-brand:
    type: button
    backgroundColor: transparent
    textColor: '#df1c13'
    typography: 16px / 400
    hover: '#645b4a'
    pressed: '#645b4a'
    use: 'Brand-red text action, including the wordmark link. Same #645b4a on hover and pressed.'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    sans: Chatwork Sans R
    display: Chatwork Sans B
---

# Chatwork

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Chatwork; reproduced for educational reference. Full prose: https://oh-my-design.kr/chatwork/design.md
