---
name: Malt
colors:
  primary: '#fc5757'
  primary-hover: '#d4524f'
  primary-90: '#a63633'
  primary-10: '#fff4f4'
  secondary: '#0f6378'
  secondary-strong: '#035266'
  secondary-deep: '#014554'
  foreground: '#4b4b4b'
  heading: '#333330'
  text-support: '#737370'
  border: '#e0ded9'
  surface: '#f7f7f5'
  canvas: '#ffffff'
  brand-pink: '#ff91f0'
  brand-blue: '#0529fc'
  ai-purple: '#9035a2'
  tertiary: '#00c0db'
  quaternary: '#ffc200'
  error: '#e02d2d'
  success: '#81b928'
typography:
  button:
    fontSize: 14px
    fontWeight: 400
    use: header button
  nav:
    fontSize: 14px
    fontWeight: 400
    use: header menu
rounded:
  md: 12px
  lg: 24px
  pill: 30px
components:
  button-primary:
    type: button
    backgroundColor: '#fc5757'
    textColor: '#ffffff'
    border: '#fc5757'
    rounded: 30px
    height: 42px
    typography: 14px / 400
    hover: '#d4524f'
    pressed: '#d4524f'
    use: 'Créer mon compte in the header — coral --joy-color-primary-50, deepening to --joy-color-primary-70 #d4524f on hover and press. Keyboard focus draws nothing.'
    padding: 10px 15px
    focus: no visible change (measured 2026-10-16) on :focus-visible
  link-login:
    type: button
    backgroundColor: transparent
    textColor: '#0f6378'
    rounded: 0px
    height: 26px
    typography: 14px / 700
    hover: 'fg #035266'
    pressed: 'fg #035266'
    use: Me connecter — teal --joy-color-secondary-30 that deepens to --joy-color-secondary-50 on hover and press.
  nav-menu:
    type: button
    backgroundColor: transparent
    textColor: '#333330'
    rounded: 0px
    height: 28px
    typography: 14px / 400
    hover: 'fg #0f6378'
    pressed: 'fg #0f6378'
    use: Platforme, Entreprises, Freelances, Ressources — dark text that turns teal (--joy-color-state-hover) on hover and press.
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    display: Agrandir Tight
    sans: Moderat
---

# Malt

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Malt; reproduced for educational reference. Full prose: https://oh-my-design.kr/malt/design.md
