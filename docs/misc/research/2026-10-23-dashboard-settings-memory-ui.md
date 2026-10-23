# Dashboard settings, memory and project memory — UI research (2026-10-23)

One line: the settings page copies how mature products show memory (a list you can read, edit and delete one item at a time, plus clear-all behind a confirm), keeps one setting per row the way Slack commands do, and shows locked content as readable text with a reason instead of greyed-out forms.

```
Research question: how should soma-work show and change (1) effort, (2) every personal setting,
(3) all personal + episodic memory, (4) project memory that only admins may change?
├── Memory management in AI assistants ── ChatGPT, Claude        → 기억 tab
├── Saving patterns for settings ──────── GitHub Primer          → 개인 설정 tab, row-level save
├── Showing what a user cannot change ─── NN/g, Carbon, NSW      → 프로젝트 메모리 tab, admin-only rows
└── Fast, frequent changes ────────────── (instruction drift)    → top-bar model / effort chips
```

Reading guide: each section is a finding with its source, then what the dashboard does with it. The last section lists where the dashboard deliberately differs.

## 1. Memory management in AI assistants

**Findings**
- ChatGPT keeps memory under Settings > Personalization > Memory. The older "saved memories" view is a full list where each entry has its own delete, and a "Clear ChatGPT's memory" button at the bottom removes everything after a confirm that it cannot be undone. Turning memory off does not delete existing memories. ([OpenAI Memory FAQ](https://help.openai.com/en/articles/8983136-what-is-memory), [Memory and new controls for ChatGPT](https://openai.com/index/memory-and-new-controls-for-chatgpt/))
- Claude shows memory under Settings > Capabilities ("View and edit memory"): the summary can be read and edited directly, and "Reset memory" permanently deletes everything and cannot be undone. Edits apply to the next conversation. ([Claude Help Center: chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context))
- Both products separate memory from chat history and make the user able to see *everything* that is remembered, not a sample.

**What the dashboard does (기억 tab, #379)**
- A separate tab, not a section of the session dashboard: 개인 메모리 (agent notes `MEMORY.md`, user profile `USER.md`), 지식 페이지, 관찰 기록 (에피소딕).
- Every entry is a row with edit and delete; "모두 지우기" sits behind a confirm dialog that names the count. A single delete is instant with "되돌리기" (undo), because one entry is cheap to restore and a confirm for each would slow cleanup down.
- A capacity meter per store (the stores have hard character limits, which ChatGPT surfaces only as "memory full").
- Episodic memory is shown in full, day by day; each record can be edited or deleted, and a note can be added to today.
- Changes apply from the next prompt rebuild, said in the tab's intro, as Claude's help page says for its edits.

## 2. Saving patterns for settings

**Findings** ([Primer: Saving](https://primer.style/product/ui-patterns/saving/), [Primer: Edit](https://primer.style/product/scenario-patterns/edit/))
- Start from explicit saving; never mix explicit and automatic saving inside one form.
- Automatic saving fits imperative controls (a toggle that acts like a light switch) where the user expects the change to take effect at once.
- After a failed save, keep the user's input and say what failed, next to the field.
- Show that a save happened without making the user reload to check.

**What the dashboard does (개인 설정 tab, #372 API, #374 page)**
- One setting per row, each its own small form, mirroring the Slack model where every setting is its own command. Each row shows the Slack command next to it, so the two surfaces teach each other.
- Toggles and one-of-N choices (model, effort, verbosity, theme, persona) save on click; free text (email, Telegram chat id, webhook URL, numbers) has an explicit 저장 button next to the field. No row mixes the two.
- Each row reports its own result in place; a failed save keeps the input and shows the server's message.
- Risky settings (permission mode, sandbox, network) ask for confirmation before saving; admin-only rows say why they are locked.
- Search, "기본값과 다른 것만" (only what differs from the default) and "기본값으로" (reset) per row, because the list is long (17 settings).

## 3. Showing what a user cannot change

**Findings**
- Disabled controls are low-contrast, skipped by keyboard focus and may not be read by screen readers; information people need to read should not be shown disabled. ([Carbon: read-only states](https://carbondesignsystem.com/patterns/read-only-states-pattern/), [NN/g: button states](https://www.nngroup.com/articles/button-states-communicate-interaction/))
- When something is unavailable, say why and how it could become available, rather than only greying it out. ([Jakob Nielsen: Inactive GUI controls](https://jakobnielsenphd.substack.com/p/inactive-buttons))
- Render inputs only when the user can edit them; show read-only information as plain text. ([NSW Design System: inactive fields](https://designsystem.nsw.gov.au/docs/content/methods/inactive-fields.html))

**What the dashboard does (프로젝트 메모리 tab, #380)**
- A non-admin sees the notes as plain, selectable text with a 🔒 banner that says who can change them ("관리자만 수정할 수 있습니다"); no edit controls are rendered at all. An unauthenticated dashboard says that nobody can change them there, and why.
- An admin sees the same list plus add / edit / delete / clear, only with admin mode on.
- The page is a convenience, not the access control: the server refuses every write that is not an admin (or the viewer token) with CSRF.

## 4. Fast, frequent changes

The follow-up instruction asked that the current model and effort be changeable with one click at the very top. Those are the settings people change mid-task, so they get top-bar chips ("모델 ▾", "Effort ▾") that open a menu and save on pick, with "열린 세션에도 적용" to apply the choice to the session open in the panel as well. The session panel keeps its own model / effort row for the one session.

## Where the dashboard differs, and why

- Primer's Edit pattern lists auto-saving radio groups and selects as a "don't". The dashboard saves one-of-N choices on click because each row is a single independent setting (no multi-field form to submit) and the Slack equivalent is also one immediate command. The row shows the saved state at once, and risky choices confirm first. If users report accidental changes, the fallback is an explicit save per row.
- ChatGPT's newer memory view is a single editable summary; the dashboard keeps one row per entry, because soma-work's stores are entry lists (`§`-separated) with per-entry limits, and the agent writes entries one at a time.
