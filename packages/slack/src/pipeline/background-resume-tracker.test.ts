import { describe, expect, it } from 'vitest';
import {
  BackgroundResumeTracker,
  classifyConsumerResult,
  contentToText,
  isConsumerToolName,
  parseBackgroundLaunchId,
} from './background-resume-tracker';

const SK = 'C1:thread';
const ackText = (id: string) =>
  `Command running in background with ID: ${id}. Output is being written to: /tmp/${id}.log`;
const taskOut = (id: string, status: string, exit?: number) =>
  `<task_id>${id}</task_id>\n<status>${status}</status>${exit != null ? `\n<exit_code>${exit}</exit_code>` : ''}\n<output>...</output>`;

describe('contentToText', () => {
  it('handles string, text-block arrays, and objects', () => {
    expect(contentToText('hi')).toBe('hi');
    expect(
      contentToText([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
    expect(contentToText({ text: 'x' })).toBe('x');
    expect(contentToText(null)).toBe('');
  });
});

describe('parseBackgroundLaunchId', () => {
  it('prefers structured backgroundTaskId', () => {
    expect(parseBackgroundLaunchId({ backgroundTaskId: 'b1' })).toBe('b1');
    expect(parseBackgroundLaunchId([{ type: 'text', text: 'x', backgroundTaskId: 'b2' }])).toBe('b2');
  });
  it('falls back to the "with ID:" text form', () => {
    expect(parseBackgroundLaunchId(ackText('shell-9'))).toBe('shell-9');
    expect(parseBackgroundLaunchId('Command was manually backgrounded by user with ID: zz. ...')).toBe('zz');
  });
  it('returns undefined when no id present', () => {
    expect(parseBackgroundLaunchId('done')).toBeUndefined();
  });
});

describe('classifyConsumerResult', () => {
  it('treats a running/pending poll as non-terminal', () => {
    expect(classifyConsumerResult(taskOut('b1', 'running'))).toEqual({ id: 'b1', terminal: false, recognized: true });
    expect(classifyConsumerResult(taskOut('b1', 'pending')).terminal).toBe(false);
  });
  it('treats completed/failed/killed and exit codes as terminal', () => {
    expect(classifyConsumerResult(taskOut('b1', 'completed', 0))).toEqual({
      id: 'b1',
      terminal: true,
      recognized: true,
    });
    expect(classifyConsumerResult(taskOut('b1', 'failed', 1)).terminal).toBe(true);
    expect(classifyConsumerResult(taskOut('b1', 'killed')).terminal).toBe(true);
    expect(classifyConsumerResult('<task_id>b1</task_id>\n<exit_code>0</exit_code>').terminal).toBe(true);
  });
  it('supports the legacy structured shape', () => {
    expect(classifyConsumerResult({ status: 'completed', exitCode: 0 }).terminal).toBe(true);
    expect(classifyConsumerResult({ status: 'running' }).terminal).toBe(false);
  });
  it('treats an unparseable result as non-terminal and not recognized', () => {
    expect(classifyConsumerResult('weird output')).toEqual({ id: undefined, terminal: false, recognized: false });
  });

  it('treats a "No task found" ERROR as terminal and extracts its id', () => {
    // A short bg shell finishes and is reaped before the model polls it; the
    // later TaskOutput errors instead of returning a status. isError gates it.
    const err = 'No task found with ID: b3d8xppf4';
    expect(classifyConsumerResult(err, true)).toEqual({ id: 'b3d8xppf4', terminal: true, recognized: true });
    expect(classifyConsumerResult('No such shell: b1', true).terminal).toBe(true);
    expect(classifyConsumerResult('shell already killed', true).terminal).toBe(true);
  });

  it('does NOT treat "not found" in NON-error stdout as terminal (no premature drain)', () => {
    // A still-running poll whose captured stdout merely mentions "not found"
    // (e.g. a build log line) must stay live: isError is false here.
    const running = `${taskOut('b1', 'running')}\nnpm ERR! package not found`;
    expect(classifyConsumerResult(running, false).terminal).toBe(false);
    // And even an error envelope that still reports a live <status> is not gone.
    expect(classifyConsumerResult(`${taskOut('b1', 'running')} no task found`, true).terminal).toBe(false);
  });
});

describe('isConsumerToolName', () => {
  it('recognizes output/kill tools only', () => {
    expect(isConsumerToolName('TaskOutput')).toBe(true);
    expect(isConsumerToolName('BashOutput')).toBe(true);
    expect(isConsumerToolName('KillShell')).toBe(true);
    expect(isConsumerToolName('Bash')).toBe(false);
    expect(isConsumerToolName(undefined)).toBe(false);
  });
});

describe('BackgroundResumeTracker', () => {
  it('stays live from spawn-ack until a terminal TaskOutput', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'use-1', ackText('b1'));
    expect(t.liveCount(SK)).toBe(1);

    // running poll → still live
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b1', 'running'));
    expect(t.liveCount(SK)).toBe(1);

    // completed → drained
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b1', 'completed', 0));
    expect(t.liveCount(SK)).toBe(0);
  });

  it('drains the id-matched launch among several', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b1'));
    t.trackLaunch(SK, 'u2', ackText('b2'));
    expect(t.liveCount(SK)).toBe(2);
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b2', 'completed'));
    expect(t.liveCount(SK)).toBe(1);
    // b1 still live
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b1', 'completed'));
    expect(t.liveCount(SK)).toBe(0);
  });

  it('dedupes repeated acks for the same id', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b1'));
    t.trackLaunch(SK, 'u1', ackText('b1'));
    expect(t.liveCount(SK)).toBe(1);
  });

  it('FIFO-drains an id-less launch on a legacy id-less terminal result', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'use-x', 'done'); // no id parseable → keyed by toolUseId
    expect(t.liveCount(SK)).toBe(1);
    t.observeConsumerResult(SK, 'BashOutput', '<status>completed</status>');
    expect(t.liveCount(SK)).toBe(0);
  });

  it('does NOT drain when a terminal result carries an id we never tracked (e.g. a bg subagent)', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b1'));
    // A terminal TaskOutput for an UNRELATED id (a background subagent task) must
    // not erroneously FIFO-drain our bash launch.
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('subagent-99', 'completed'));
    expect(t.liveCount(SK)).toBe(1);
    // The real one still drains.
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b1', 'completed'));
    expect(t.liveCount(SK)).toBe(0);
  });

  it('drains on a "No task found" ERROR from a reaped short-lived shell', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b3d8xppf4'));
    expect(t.liveCount(SK)).toBe(1);
    // Non-error poll mentioning "not found" must NOT drain.
    t.observeConsumerResult(SK, 'TaskOutput', 'log says file not found', false);
    expect(t.liveCount(SK)).toBe(1);
    // The harness error envelope for a reaped task → drained.
    t.observeConsumerResult(SK, 'TaskOutput', 'No task found with ID: b3d8xppf4', true);
    expect(t.liveCount(SK)).toBe(0);
  });

  it('fires onUnrecognized for an opaque consumer result', () => {
    const seen: string[] = [];
    const t = new BackgroundResumeTracker((toolName) => seen.push(toolName));
    t.trackLaunch(SK, 'u1', ackText('b1'));
    t.observeConsumerResult(SK, 'TaskOutput', 'totally opaque blob');
    expect(seen).toEqual(['TaskOutput']);
    expect(t.liveCount(SK)).toBe(1); // unrecognized → kept live
  });

  it('ignores non-consumer tools and non-terminal results', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b1'));
    t.observeConsumerResult(SK, 'Read', taskOut('b1', 'completed'));
    expect(t.liveCount(SK)).toBe(1);
    t.observeConsumerResult(SK, 'TaskOutput', taskOut('b1', 'running'));
    expect(t.liveCount(SK)).toBe(1);
  });

  it('drains a whole session on cap exhaustion', () => {
    const t = new BackgroundResumeTracker();
    t.trackLaunch(SK, 'u1', ackText('b1'));
    t.trackLaunch(SK, 'u2', ackText('b2'));
    t.drain(SK);
    expect(t.liveCount(SK)).toBe(0);
  });
});
