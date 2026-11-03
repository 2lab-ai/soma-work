/**
 * #854 — epics as Slack sessions, the wiring in `src/index.ts` and the session initializer (source
 * contract, as `shutdown-followup-contract.test.ts`: importing `index.ts` would boot the bot).
 *
 *   W1 the epic's tools act through the Slack host: children are threads, instructions are
 *      messages, the tree's limits gate them.
 *   W2 a settled chain: a child reports its end to its epic; an epic may wake.
 *   W3 an event on an epic wakes it on its own path (a dashboard task's epic on the task path,
 *      a Slack epic on the Slack path); the boot scan wakes a Slack epic too.
 *   W4 a new child placed in its epic's folder works there (the session initializer's override).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

function section(from: string, to: string, text = source): string {
  const start = text.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, `missing after ${from}: ${to}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('index.ts — epics as Slack sessions (#854)', () => {
  it('W1 — the epic host is the Slack host, gated by the tree’s limits', () => {
    const host = section('setEpicHost(\n      createSlackEpicHost({', '\n    );');
    expect(host).toMatch(/reserveEpicChild: \(epicTaskId, planNodeId\) => epicRegistry\.reserveEpicChild/);
    expect(host).toMatch(
      /onTurnAccepted: \(channel, ts, accepted\) => slackHandler\.onTurnAccepted\(channel, ts, accepted\)/,
    );
    expect(host).toMatch(/sendToThread: sendAsOwner/);
    expect(host).toMatch(/gate: epicTreeGate/);
    const send = section('const sendAsOwner = ', 'setEpicHost(');
    expect(send).toMatch(
      /injectDashboardMessage\(key, text, undefined, \[\], undefined, undefined, \{[\s\S]*verbatim: true,[\s\S]*echoLabel: opts\.label/,
    );
    // An epic's wake and its word to a child are host turns (review #872 astra): never the owner's answer.
    expect(send).toMatch(/\.\.\.\(opts\.hostTurn \? \{ hostTurn: true as const \} : \{\}\)/);
    expect(source).toMatch(
      /routeContext: \{ verbatimPrompt: true, \.\.\.\(extra\.hostTurn \? \{ hostTurn: true \} : \{\}\) \}/,
    );
  });

  it('W2 — a settled chain: a child records its end on its epic; an epic may wake', () => {
    const settled = section('slackHandler.setChainSettledListener((key, outcome) => {', '\n    });');
    expect(settled).toMatch(/const end = chainEndOf\(outcome\);/);
    expect(settled).toMatch(/epicRegistry\.recordSessionChainEnd\(key, end\)/);
    // An epic's chain end settles the wakes it ran (never one still being sent), then it may wake again.
    expect(settled).toMatch(/if \(session\.kind === 'epic'\) slackEpicWaker\.chainEnded\(key\);/);
    const waker = section('const slackEpicWaker = createSlackEpicWaker({', '\n    });');
    expect(waker).toMatch(/settle: \(key, keep\) => epicRegistry\.settleEpicWakes\(key, keep\)/);
  });

  it('W3 — an event wakes the epic (the Slack path, the only one since #855); the boot scan wakes a Slack epic', () => {
    expect(source).toMatch(/setEpicEventListener\(\(key\) => slackEpicWaker\.wake\(key\)\)/);
    expect(source).not.toMatch(/createEpicWaker\(/);
    expect(source).toMatch(/if \(session\.kind === 'epic' && !session\.parentTaskId\) slackEpicWaker\.wake\(key\);/);
  });

  it('W4 — a new child placed in its epic’s folder works there, not registered for cleanup', () => {
    const init = fs.readFileSync(
      path.join(__dirname, '..', '..', 'packages', 'slack', 'src', 'pipeline', 'session-initializer.ts'),
      'utf8',
    );
    const block = section('const placedDir = event.workingDirectoryOverride', '} else if (sessionDir) {', init);
    expect(block).toMatch(/createSessionBaseDir\(user\)/);
    expect(block).toMatch(/if \(placedDir\) \{\s*session\.sessionWorkingDir = placedDir;/);
    expect(block).not.toMatch(/addSourceWorkingDir/);
  });
});

describe('#854 — a placed folder is checked again where it is used (review #872 grok P0)', () => {
  it('W5 — the initializer takes the override only through the host’s validator; the handler wires the owner-root check', () => {
    const init = fs.readFileSync(
      path.join(__dirname, '..', '..', 'packages', 'slack', 'src', 'pipeline', 'session-initializer.ts'),
      'utf8',
    );
    expect(init).toMatch(
      /const placedDir = event\.workingDirectoryOverride\s*\?\s*this\.deps\.placedDirOf\?\.\(user, event\.workingDirectoryOverride\)\s*:\s*undefined;/,
    );
    const handler = fs.readFileSync(path.join(__dirname, '..', 'slack-handler.ts'), 'utf8');
    expect(handler).toMatch(/placedDirOf: \(user, dir\) => \{\s*try \{\s*return taskDirectoryFor\(user, dir\);/);
  });
});

describe('#854 — every door a Slack event comes in by drops the host-only fields (review #872 R2 fable)', () => {
  it('W6 — the assistant-thread door (app.assistant → handleMessage) strips them as EventRouter does', () => {
    const handler = fs.readFileSync(path.join(__dirname, '..', 'slack-handler.ts'), 'utf8');
    const door = section('createAssistantContainer({', '}),', handler);
    expect(door).toMatch(/handleMessage: \(event, say\) => this\.handleMessage\(withoutHostOnlyFields\(event\), say\)/);
  });
});
