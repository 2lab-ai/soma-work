---
name: note
colors:
  brand: '#41c9b4'
  theme: '#2cb696'
  theme-dark: '#228d74'
  primary: '#000000'
  canvas: '#f7f9f9'
  surface: '#ffffff'
  text: '#222222'
  on-primary: '#ffffff'
typography:
  body:
    fontWeight: 400
    use: Long-form Japanese article body
  heading:
    fontWeight: 700
    use: Titles and headings
rounded:
  sm: 8px
  md: 8px
  lg: 8px
  full: 9999px
spacing:
  sm: 8
  base: 16
components:
  button-primary:
    type: button
    backgroundColor: '#000000'
    textColor: '#ffffff'
    rounded: 8px
    use: Primary action (Publish / フォロー / 投稿)
  button-secondary:
    type: button
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    use: Lower-emphasis action
  button-theme:
    type: button
    backgroundColor: '#2cb696'
    textColor: '#ffffff'
    rounded: 8px
    use: Brand-context action, the teal moment
  article-card:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    use: Article preview on off-white canvas
  editor-canvas:
    type: card
    backgroundColor: '#ffffff'
    textColor: '#222222'
    use: Distraction-free long-form editor
  text-field:
    type: input
    backgroundColor: '#ffffff'
    textColor: '#222222'
    rounded: 8px
    use: Forms, search, profile fields
fonts:
  roles:
    sans: Hiragino Kaku Gothic ProN
    mono: Hiragino Kaku Gothic ProN
---

# note

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to note; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/note/DESIGN.md
