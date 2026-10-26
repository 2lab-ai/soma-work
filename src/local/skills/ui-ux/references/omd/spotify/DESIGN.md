---
name: Spotify
colors:
  primary: '#1ed760'
  control: '#1f1f1f'
  foreground: '#ffffff'
  muted: '#b3b3b3'
  outline: '#7c7c7c'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    use: Product-player body and input text
  action:
    fontSize: 14px
    fontWeight: 700
    use: Compact player action labels
rounded:
  search: 500px
  control: 9999px
components:
  player-search:
    type: input
    backgroundColor: '#1f1f1f'
    textColor: '#ffffff'
    border: '0px solid #ffffff'
    rounded: 500px
    padding: 12px 96px 12px 48px
    typography: 16px / 400 / SpotifyMixUI
    states: focus, hover, and pressed snapshots observed
    use: Open Spotify player search field; home and /search
  player-outlined-action:
    type: button
    backgroundColor: transparent
    textColor: '#ffffff'
    border: '1px solid #7c7c7c'
    rounded: 9999px
    padding: 4px 16px 4px 36px
    typography: 14px / 700 / SpotifyMixUI
    states: focus, hover, and pressed snapshots observed
    use: Compact outlined player action; home and /search
  player-icon-control:
    type: button
    backgroundColor: '#1f1f1f'
    textColor: '#ffffff'
    rounded: 50%
    padding: 12px
    typography: 16px / 400 / SpotifyMixUI
    states: hover and pressed snapshots observed
    use: 48px circular player icon control on the home surface
  newsroom-cta:
    type: button
    backgroundColor: '#1ed760'
    textColor: '#000000'
    border: '1px solid #1ed760'
    rounded: 100px
    padding: 16px 33px 15px
    typography: 14px / 800 / Spotify Mix
    states: focus and pressed snapshots observed
    use: Editorial/newsroom CTA only; not promoted to player chrome
    height: 50px
    pressed: 'bg #ffffff, border #000000 (+1 nested-layer changes) (:hover + :active)'
    focus: 'bg #1ab752, browser default focus ring (outline auto) on :focus-visible'
omitted:
  - section: spacing
    reason: No verified values in current evidence.
fonts:
  roles:
    ui: SpotifyMixUI
    title: SpotifyMixUITitle
---

# Spotify

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to Spotify; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/spotify/DESIGN.md
