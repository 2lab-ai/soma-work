# How to show a user's attached files in the dashboard

Research for the SSOT of 25 October 2026: "유저가 입력한 SSOT 미디어를 대시보드에서 확인할 수 있어야함 — 어떻게 출력되면 좋을지 현재 서피스 ui 확인하고 어떻게 출력할지 리서치하고 개선".

## Conclusion

Show each attachment on the user's own turn, above the instruction text. Use a small grid of square image tiles and compact cards for other files. Open them in the existing viewer. Keep them out of the model's artifact strip. Put only a paperclip and a count on the board card.

## What the dashboard showed before

Every surface that shows an instruction showed its text only:

- the side panel's user turn (`dashboard.ts renderTurn`)
- the open card's 지시 row (`renderCardIo`). A files-only instruction read "기록된 지시 없음"
- the Full Conversation page (`viewer.ts`)
- the work log's instruction entry

The cause was in the data, not the UI. `ConversationTurn` stored only `rawContent`. The bot downloaded files to the temp directory, passed their paths to the model, and deleted them when the turn ended. A steered message, sent while a turn runs, was not recorded at all.

## How other products show attached files

Chat products:

- ChatGPT, Claude.ai and Gemini put attachments inside the user's message, above the text. Images are rounded thumbnails. Other files are cards with an icon, the name and the type.
- Claude allows 20 files per chat, Gemini 10 per prompt and Slack 10 per message.
- ChatGPT's Library separates files the user uploaded from files ChatGPT made.

Agent dashboards:

- Devin's image lightbox moves between images with the arrow keys. HTML, PDF and SVG files open in a new tab.
- Cursor keeps the conversation, the code changes and the agent's artifacts apart.
- GitHub Copilot's coding agent treats the issue body, images included, as the prompt.

Messaging:

- Slack, Telegram and WhatsApp show at most 4 image tiles. With 5 or more, the 4th tile shows "+N".
- Slack has a "Files and links" tab for every file in a channel.

## Accessibility and security guidance

Accessibility:

- Make each thumbnail a button named by its action, for example "이미지 열기 2/5: login.png". Do not use the file name as alt text.
- The lightbox follows the WAI-ARIA modal dialog pattern. Escape closes it, and focus returns to the thumbnail that opened it.
- Set a size on every image box so the layout does not shift when the image loads.

Security:

- Choose the content type on the server from an allowlist. Send `nosniff`.
- Serve uploaded HTML and SVG with a sandbox CSP and no scripts.
- Never build a storage path from the user's file name.

## Numbers used

- Image tiles: 80px square, 4px gap, 8px corners, cropped to fill.
- One image on its own: a fixed 280 by 200 box, image contained.
- Up to 4 tiles, then "+N" on the 4th.
- File cards: 52px tall. Touch targets: 44px.
- Board card: paperclip and count only, never an image.

## Sources

- [Upload files to Claude](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
- [Gemini file upload limits](https://support.google.com/gemini/answer/14903178)
- [Add files to Slack](https://slack.com/help/articles/201330736-Add-files-to-Slack)
- [Slack file object](https://docs.slack.dev/reference/objects/file-object)
- [Devin release notes](https://docs.devin.ai/release-notes/overview)
- [Cursor cloud agents](https://cursor.com/docs/cloud-agent)
- [GitHub Copilot coding agent](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)
- [Telegram albums](https://telegram.org/blog/albums-saved-messages)
- [AI Elements attachments component](https://elements.ai-sdk.dev/components/attachments)
- [WAI-ARIA modal dialog pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [W3C images decision tree](https://www.w3.org/WAI/tutorials/images/decision-tree/)
- [Optimize Cumulative Layout Shift](https://web.dev/articles/optimize-cls)
- [Securely hosting user data](https://web.dev/articles/securely-hosting-user-data)
- [OWASP file upload cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
