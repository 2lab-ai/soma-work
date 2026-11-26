/**
 * The board's 작업 큐 section and the settings page read the work queues through this one view (.prd/36 v2 §4.3):
 * the lanes (`qa-dev2`, one at a time) and each person's queue (as many at once as their limit) in the same shape —
 * what runs, what waits in order, and what recently left (the history that shows a lane ran one at a time).
 *
 * Pure: the lanes and people come in as line views (`somalib/work-queue/line.ts`), the session lookups as functions.
 * Each entry and record is named for the reader: its task's title, owner, board card and thread link — and a task in a
 * private channel (a DM, a private channel) is named only to its owner and to admins (#1315): to anyone else it is
 * `비공개 작업`, with no keys, no title and no link.
 */
import type { LineEntryView, LineHolder, LineQueueView, LineRecord } from 'somalib/work-queue/line';

export const PRIVATE_TITLE = '비공개 작업';

export interface WqTask {
  /** The board card key, when the thread has a session the board knows. */
  key?: string;
  title: string;
  ownerId: string;
  ownerName: string;
  slackThreadUrl?: string;
  /** Masked for this reader: no title, keys or link. */
  hidden?: boolean;
}

export interface WqEntryOut {
  id: string;
  state: 'running' | 'waiting';
  position: number;
  keys: string[];
  enteredAt: number;
  startedAt?: number;
  /** A lane's note or a request's first words. */
  label?: string;
  task: WqTask;
}

export interface WqRecordOut {
  id: string;
  end: LineRecord['end'];
  reason?: string;
  keys: string[];
  label?: string;
  enteredAt: number;
  startedAt?: number;
  endedAt: number;
  task: WqTask;
}

export interface WqQueueOut {
  id: string;
  kind: 'lane' | 'person';
  /** The lane's name, or the person's. */
  title: string;
  /** How many run at once; `null` = no limit. */
  capacity: number | null;
  running: WqEntryOut[];
  waiting: WqEntryOut[];
  /** Newest first. */
  recent: WqRecordOut[];
}

export interface WorkQueuesView {
  lanes: WqQueueOut[];
  people: WqQueueOut[];
  /** The reader is an admin: the 먼저 진행 · 빼기 · 돌려놓기 controls (sent with admin mode on). */
  canManage: boolean;
}

export interface WorkQueuesViewDeps {
  /** The session of a thread, when there is one. */
  sessionAt(channel: string, threadTs: string): { key: string; title?: string; ownerId?: string } | undefined;
  nameOf(userId: string): string;
  permalink(channel: string, threadTs: string): string | undefined;
  isPrivate(channel: string): boolean;
  /** The signed-in reader (undefined for a viewer token, which sees everything). */
  viewer?: string;
  admin: boolean;
}

function taskOf(holder: LineHolder, fallbackTitle: string | undefined, deps: WorkQueuesViewDeps): WqTask {
  const s = deps.sessionAt(holder.channel, holder.threadTs);
  const ownerId = holder.user || s?.ownerId || '';
  const visible = !deps.isPrivate(holder.channel) || deps.admin || !deps.viewer || deps.viewer === ownerId;
  if (!visible) return { title: PRIVATE_TITLE, ownerId, ownerName: deps.nameOf(ownerId), hidden: true };
  return {
    ...(s ? { key: s.key } : {}),
    title: s?.title || fallbackTitle || '제목 없는 작업',
    ownerId,
    ownerName: deps.nameOf(ownerId),
    ...(holder.channel && holder.threadTs
      ? { slackThreadUrl: deps.permalink(holder.channel, holder.threadTs) ?? undefined }
      : {}),
  };
}

function entryOut(e: LineEntryView, deps: WorkQueuesViewDeps): WqEntryOut {
  const task = taskOf(e.holder, e.label, deps);
  return {
    id: e.id,
    state: e.state,
    position: e.position,
    keys: task.hidden ? [] : [...e.keys],
    enteredAt: e.enteredAt,
    ...(e.startedAt !== undefined ? { startedAt: e.startedAt } : {}),
    ...(!task.hidden && e.label ? { label: e.label } : {}),
    task,
  };
}

function recordOut(r: LineRecord, deps: WorkQueuesViewDeps): WqRecordOut {
  const task = taskOf(r.holder, r.label, deps);
  return {
    id: r.id,
    end: r.end,
    ...(r.reason && !task.hidden ? { reason: r.reason } : {}),
    keys: task.hidden ? [] : [...r.keys],
    ...(!task.hidden && r.label ? { label: r.label } : {}),
    enteredAt: r.enteredAt,
    ...(r.startedAt !== undefined ? { startedAt: r.startedAt } : {}),
    endedAt: r.endedAt,
    task,
  };
}

function queueOut(q: LineQueueView, title: string, deps: WorkQueuesViewDeps): WqQueueOut {
  return {
    id: q.id,
    kind: q.kind,
    title,
    capacity: q.capacity,
    running: q.running.map((e) => entryOut(e, deps)),
    waiting: q.waiting.map((e) => entryOut(e, deps)),
    recent: q.recent.map((r) => recordOut(r, deps)),
  };
}

/** The lanes, then the people (each person's queue titled by their name), named for the reader. */
export function buildWorkQueuesView(
  input: { lanes: readonly LineQueueView[]; people: readonly LineQueueView[] },
  deps: WorkQueuesViewDeps,
): WorkQueuesView {
  return {
    lanes: input.lanes.map((q) => queueOut(q, q.id, deps)),
    people: input.people.map((q) => queueOut(q, deps.nameOf(q.id.replace(/^user:/, '')), deps)),
    canManage: deps.admin,
  };
}
