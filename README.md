<h1 align="center">soma-work</h1>

<p align="center"><strong>Ask in Slack. Watch it work.</strong></p>

<p align="center">Claude Code agents for your team. Start one from Slack, the dashboard or your voice. Each one is a card you can open.</p>

<p align="center">
  <a href="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml"><img src="https://github.com/2lab-ai/soma-work/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/2lab-ai/soma-work/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" /></a>
</p>

<p align="center">
  <a href="#ask">ask</a> · <a href="#watch-it-work">watch</a> · <a href="#step-in">step in</a> · <a href="#run-it">run it</a> · <a href="#docs">docs</a> · <a href="./README.ko.md">한국어</a>
</p>

![The soma-work dashboard: three columns (needs you, running, done) of task cards, each with its status, PRs, cost and Slack channel](assets/readme/board.png)

<sub>The real dashboard in its Modern Mono theme, 2026-11-09, filtered to this repository. Cards that name private hosts are hidden. The UI is in Korean, the default display language.</sub>

## Ask

Three ways in. Each one starts the same thing: a Slack thread and a card on the board.

- **Slack:** mention the bot in a channel, or reply in its thread.
- **Dashboard:** **New task** (`Ctrl+N`), type, send.
- **Voice:** press **Dictation** in New task and speak.

![Typing an instruction into New task and sending it; the card lands on the board in the same words](assets/readme/ask.gif)

![Dictation: the spoken request is written into New task as it is heard](assets/readme/voice.gif)

## Watch it work

Open a card.

- **Conversation:** your instruction and the agent's replies. It is the same thread as in Slack.
- **Tasks:** the agent's plan. Each step is done, running or waiting.
- **Work log:** every tool call as it runs, grouped by task.

![Opening a card: the conversation, then the task list, then the live work log](assets/readme/work.gif)

## Step in

- **It asks first.** A permission prompt or a question moves the card to **Needs you**. Answer on the card or in Slack.
- **Steer:** write to the running agent from the card.
- **Stop** it, or **roll its context back** to an earlier point.

## What comes back

- The PRs, issues and docs it made, on the card, with their state.
- A TL;DR when the work ends.
- Cost, tokens and model, per card.

## Run it

From source, today:

```bash
git clone https://github.com/2lab-ai/soma-work.git && cd soma-work && npm install
cp .env.example .env    # SLACK_BOT_TOKEN, SLACK_APP_TOKEN, BASE_DIRECTORY
npm run dev
```

Create the Slack app from [`infra/slack/slack-app-manifest.json`](infra/slack/slack-app-manifest.json) first. Node.js 22+. The full guide, with deployment and GitHub setup, is [Running soma-work](docs/misc/guides/setup.md). A packaged installer (`somawork setup`) is built but not published yet.

## Only the workflow

The agent workflow soma-work runs, `zworkflow`, is a Claude Code plugin. Use it in your own Claude Code, without Slack:

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

[MIT](./LICENSE)
