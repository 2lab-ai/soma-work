---
name: maum.ai (ex-MindsLab)
colors:
  primary: '#4262ff'
  on-primary: '#ffffff'
  dark: '#343434'
  nav-selected: '#292d33'
  secondary: '#5b636d'
  ink: '#111111'
  lead-grey: '#595959'
  nav-muted: '#8e8e8e'
  muted: '#949ca5'
  white: '#ffffff'
  selected-tint: '#e2edfc'
  hover-surface: '#f2f3f7'
  hairline: '#dee4eb'
  underline: '#d2dcea'
typography:
  display-hero:
    fontSize: 72px
    fontWeight: 700
    lineHeight: 1.02
    use: 'Home headline (Physical AI 로봇을 구독하세요.), Jamsil, 73.6px line, in #111111'
  section-title:
    fontSize: 48px
    fontWeight: 700
    lineHeight: 1
    use: Page headings on /physical-ai-service (Physical AI Product) and /maum-gpt (maumChatbot), Pretendard, 48px line
  product-name:
    fontSize: 32px
    fontWeight: 600
    lineHeight: 1.13
    use: Product names on the /physical-ai-service cards, 36px line
  prompt-title:
    fontSize: 24px
    fontWeight: 700
    lineHeight: 1.33
    use: Chat prompt heading on /maum-gpt (지금 MAAL과 대화해 보세요.), 32px line; chatbot product surface
  section-label:
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
    use: Section label above the product cards on /physical-ai-service, 32px line
  lead:
    fontSize: 20px
    fontWeight: 500
    lineHeight: 1.3
    use: 'Product descriptions in the home carousel, 26px line, in #595959'
  description:
    fontSize: 20px
    fontWeight: 400
    lineHeight: 1.45
    use: Page introductions on /physical-ai-service and /maum-gpt, 29px line
  button-lg:
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    use: Contact Us label on home, 25px line
  nav:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.25
    use: 'Home navigation links (Physical AI, Defense, MAIED, 회사소개), 20px line, in #8e8e8e'
  button:
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.25
    use: 새로운 대화 and Retrieval 모델 설정 labels on /maum-gpt, 20px line
  body:
    fontSize: 16px
    fontWeight: 500
    lineHeight: 1.25
    use: 'Document default on all three pages, 20px line, in #111111'
  caption:
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.14
    use: 'Small grey meta text on /physical-ai-service, 16px line, in #949ca5'
rounded:
  menu: 8px
  card: 10px
  action: 12px
  pill: 9999px
spacing:
  cta-y: 20
  cta-x: 32
  side-y: 32
  side-x: 16
  list-y: 16
  list-x: 20
  icon-inset: 48
components:
  contact-cta:
    type: button
    backgroundColor: '#343434'
    textColor: '#ffffff'
    rounded: 9999px
    padding: 20px 32px
    height: 65px
    typography: 20px / 600 / 25px Pretendard
    hover: background-color becomes transparent and a linear-gradient(93deg, rgb(107, 157, 205) 0%, rgb(113, 166, 47) 170.68%) fills the pill
    pressed: the same gradient
    states: settles at once (transition all 0s); focus draws only the browser's default ring, so no brand focus style is declared
    use: Contact Us under the home headline, 192 x 65; marketing page
  gnb-link:
    type: tab
    textColor: '#8e8e8e'
    typography: 16px / 700 / 20px Pretendard
    hover: 'fg #111111'
    pressed: 'fg #111111'
    states: 0.2s colour transition on cubic-bezier(0.4, 0, 0.2, 1); focus draws only the browser default ring
    use: Home navigation (Physical AI, Defense, MAIED, 회사소개)
  top-button:
    type: button
    backgroundColor: '#ffffff'
    rounded: 9999px
    size: 48px x 48px
    shadow: rgba(18, 44, 72, 0.2) 0px 2px 8px 0px
    states: hover and pressed show no change
    use: Back-to-top circle on home, the one lifted control captured
  new-chat-button:
    type: button
    backgroundColor: '#4262ff'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0px 0px 0px 48px
    height: 56px
    typography: 16px / 700 / 20px Pretendard
    states: hover and pressed show no change (transition all 0s); focus draws only the browser default ring
    use: 새로운 대화, the primary action of the maumChatbot page, 208 x 56 with an icon inset at the left; chatbot product surface
  retrieval-button:
    type: button
    backgroundColor: '#5b636d'
    textColor: '#ffffff'
    rounded: 12px
    padding: 0px 0px 0px 48px
    height: 56px
    typography: 16px / 700 / 20px Pretendard
    states: hover and pressed show no change
    use: Retrieval 모델 설정 at the foot of the chatbot sidebar, 208 x 56; chatbot product surface
  chat-list-item:
    type: tab
    backgroundColor: transparent
    textColor: '#111111'
    rounded: 12px
    padding: 16px 20px
    height: 48px
    typography: 16px / 700 / 20px Pretendard
    selected: 'bg #e2edfc with a 1px #d2dcea bottom border and 12px 12px 0 0 corners'
    hover: 'bg #f2f3f7 with a 1px #d2dcea bottom shadow line'
    pressed: 'bg #f2f3f7 with the same line'
    states: 0.15s transition on cubic-bezier(0.4, 0, 0.2, 1); the selected item gains only the line on hover
    use: Chatbot list in the /maum-gpt sidebar (외부 GPT selected, MAAL and others); chatbot product surface
  side-menu-item:
    type: tab
    textColor: '#111111'
    rounded: 12px
    padding: 32px 16px
    height: 64px
    typography: 16px / 700 / 20px Pretendard
    selected: 'bg #292d33, fg #ffffff, 16px / 600, 16px padding, 52px tall'
    hover: 'bg #f2f3f7 with a 1px #d2dcea bottom shadow line'
    pressed: 'bg #f2f3f7 with the same line'
    states: the selected item fades to opacity 0.9 on hover and press; 0.15s transition on cubic-bezier(0.4, 0, 0.2, 1)
    use: Left menu of /physical-ai-service (HOME selected, AI Integration Module and others), 176px wide
  language-dropdown:
    type: button
    textColor: '#111111'
    rounded: 8px
    size: 80px x 40px
    typography: 16px / 500 / 20px Pretendard
    hover: 'bg #f2f3f7'
    pressed: 'bg #f2f3f7'
    states: 0.15s transition
    use: KOR language toggle in the header of /physical-ai-service and /maum-gpt
  product-card:
    type: card
    backgroundColor: transparent
    border: '1px solid #dee4eb'
    rounded: 10px
    size: 355px x 487px
    shadow: rgb(222, 228, 235) 0px 1px 0px 0px
    use: Product cards on /physical-ai-service (4 instances)
  chat-input:
    type: input
    textColor: '#111111'
    padding: 8px 40px
    height: 40px
    typography: 16px / 500 / 24px Pretendard
    disabled: the textarea is disabled for logged-out visitors
    use: Message field of the maumChatbot page, 517 x 40; never typed into; chatbot product surface
fonts:
  roles:
    display: Jamsil
    body: Pretendard
---

# maum.ai (ex-MindsLab)

Tokens only (frontmatter, verbatim from oh-my-design `c71ca8d`). The design described here belongs to maum.ai (ex-MindsLab); reproduced for educational reference. Full prose: https://oh-my-design.kr/maum-ai/design.md
