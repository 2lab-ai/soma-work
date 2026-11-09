<h1 align="center">soma-work</h1>

<p align="center"><strong>Ask in Slack. Watch it work.</strong></p>

<p align="center">A self-hosted Slack bot that runs Claude Code agents for your team. Every task is a card you can open.</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-ISC-blue.svg" alt="License: ISC" /></a>
</p>

<p align="center">
  <a href="#ask-in-slack">ask in Slack</a> · <a href="#pick-it-up-on-the-dashboard">pick it up</a> · <a href="#keep-going-from-the-card">keep going</a> · <a href="#watch-it-work">watch</a> · <a href="#or-start-on-the-dashboard">start on the dashboard</a> · <a href="#step-in">step in</a> · <a href="#run-it">run it</a> · <a href="#docs">docs</a> · <a href="./README.ko.md">한국어</a>
</p>

![The soma-work dashboard: three columns (needs response, running, done) of task cards, each with its status, PRs, cost and Slack channel](assets/readme/en/board.png)

<sub>The real dashboard, filtered to this repository (private cards hidden). It starts in Korean: press EN at the top right, or send the bot `lang en`. Card titles and TL;DRs are written by the agent, so some are in Korean.</sub>

## Ask in Slack

Mention the bot in a channel. It starts a thread for the task and answers there.

![In Slack: a one-line request to the bot; it starts a thread for the task and answers there](assets/readme/en/slack.gif)

## Pick it up on the dashboard

The same request is a card on the board. Open it: in **Conversations**, your Slack message comes first, the agent's reply under it.

![On the dashboard: the card the Slack request made; opened, it shows the Slack message and the reply](assets/readme/en/pickup.gif)

## Keep going from the card

Write your next instruction in the card's message box. It goes into the same Slack thread (marked "via Dashboard"), so the agent carries on where it was.

![A follow-up typed into the opened card and sent; the agent picks it up](assets/readme/en/continue.gif)

## Watch it work

- **Conversations:** your instructions and the agent's answers.
- **Tasks:** the agent's plan. Each step is done, running or waiting.
- **Work log:** every tool call as it runs, grouped by task (your own tasks; admins see all).

![The opened card: the conversation, then the task list, then the live work log](assets/readme/en/work.gif)

## Or start on the dashboard

- **New task:** type, **Start task**. It starts a Slack thread in the channel you pick.
- **Dictation:** press it in New task or a card's message box and speak; the words appear as you talk.

![Typing an instruction into New task and sending it; the card lands on the board in the same words](assets/readme/en/ask.gif)

![Dictation: the spoken request is written into New task as it is heard](assets/readme/en/voice.gif)

## Step in

- **When it asks:** a permission prompt or a question moves the card to **Needs response**. Answer on the card or in Slack.
- **Steer:** while it runs, ↵ queues your note as the next step; ⌘↵ (Ctrl+↵) steers it now.
- **Stop or roll back:** stop it, or roll its context back to an earlier point.

## What comes back

- The PRs, issues and docs of the work, on the card. PRs and issues show their state.
- A TL;DR when the work ends.
- Cost, tokens and model, per card.

## Run it

You run it on your own machine. From source, today (Node.js 20+):

1. Create a Slack app from [`infra/slack/slack-app-manifest.json`](infra/slack/slack-app-manifest.json) and install it. Copy the bot token (`xoxb-`) and an app-level token with `connections:write` (`xapp-`).
2. Give it Claude: an [llmux](https://github.com/2lab-ai/llmux) on the same machine (found at start), or `CLAUDE_CODE_OAUTH_TOKEN` in `.env` (from `claude setup-token`).
3. Build and start:

```bash
git clone https://github.com/2lab-ai/soma-work.git && cd soma-work
npm install && npm run build
cp .env.example .env    # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, BASE_DIRECTORY
npm run dev
```

The dashboard is at `http://127.0.0.1:3000/dashboard` (port 33000 off `main`). Full guide: [Running soma-work](docs/misc/guides/setup.md).

## Only the workflow

soma-work's agent workflow, `zworkflow`, is a Claude Code plugin. Use it without Slack:

```text
/plugin marketplace add 2lab-ai/soma-work
/plugin install zworkflow@soma-work
```

Details: [zworkflow plugin README](./src/local/README.md).

## Docs

- [Running soma-work](docs/misc/guides/setup.md): install, configuration, deployment, GitHub, troubleshooting
- [Commands](docs/misc/guides/commands.md): `/z`, `%`, `$` and bare commands
- [Features and architecture](docs/misc/guides/features.md): every feature in detail
- [Working on soma-work](docs/misc/guides/contributing.md): project structure, design principles, tests
- [Docs map](docs/README.md) and [ADRs](docs/adr/README.md)

If you are an AI agent working on this repository, read [`CLAUDE.md`](CLAUDE.md) and [`AGENTS.md`](AGENTS.md) first.

## License

[ISC](./LICENSE)
