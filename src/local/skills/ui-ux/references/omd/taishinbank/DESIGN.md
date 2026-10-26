---
name: 台新銀行
colors:
  canvas: '#f9f9f9'
  foreground: '#212529'
  link: '#0056b3'
typography:
  body:
    fontSize: 16px
    fontWeight: 400
    lineHeight: 16
    use: Computed public Taishin page body on the personal and investment routes; family intentionally omitted
rounded:
  square: 0px
components:
  investment-fund-card:
    type: card
    backgroundColor: transparent
    textColor: '#212529'
    border: '1px solid #e3e3e3'
    rounded: 0px
    padding: 0px
    typography: 16px / 400 / unresolved computed family
    height: 206px
    use: Static public investment card, selector surface-2::div.ts-comp-iFund-card; nine observed instances
omitted:
  - section: spacing
    reason: No verified values in current evidence.
---

# 台新銀行

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to 台新銀行; reproduced for educational reference. Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/c71ca8d8a530fde51c7b03967fdaf45dceedb254/design-md/taishinbank/DESIGN.md
