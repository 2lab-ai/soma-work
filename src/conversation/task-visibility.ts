/**
 * Who may see a task on the dashboard (SSOT 2026-11-16, #1315): a private task is its owner's and the admins'.
 *
 *   private task  its Slack conversation is one not everyone can read — a private channel, a DM with the bot, or a
 *                 channel the channel registry does not say is public (a group DM, a channel the bot left, every
 *                 channel before the startup scan has answered). Not knowing counts as private: a hidden card comes
 *                 back on the next refresh, a card shown to the wrong person cannot be taken back. A public channel's
 *                 task, and an old dashboard task with no Slack conversation, are everyone's, as before.
 *   who sees one  its owner, and an admin (ADMIN_USERS, or the viewer token — both `isAdmin`). Reading needs no admin
 *                 mode, like the work log and the code changes. Anyone else gets nothing: no card on the board, no
 *                 live push, and 404 from its routes, as if the task did not exist.
 *
 * Pure apart from the registry lookup, which the caller can replace.
 */

import { getChannel } from '../channel-registry';

/** The channel registry's answer about one channel; undefined when it does not know the channel. */
export type PrivacyLookup = (channelId: string) => { isPrivate?: boolean } | undefined;

/** The signed-in viewer as the dashboard knows it: an AuthContext, or a live socket's copy of one. */
export interface TaskViewer {
  userId?: string;
  isAdmin?: boolean;
}

/** A task's Slack conversation is not everyone's to read (see the module comment). */
export function isPrivateTask(channelId: unknown, lookup: PrivacyLookup = getChannel): boolean {
  if (typeof channelId !== 'string' || !channelId) return false;
  // A DM with the bot: in Slack nobody but its two members reads it.
  if (channelId.startsWith('D')) return true;
  let known: ReturnType<PrivacyLookup>;
  try {
    known = lookup(channelId);
  } catch {
    // A registry that cannot answer has not said the channel is public.
    return true;
  }
  return !(known && known.isPrivate === false);
}

/** The viewer may see private tasks of `ownerId`: an admin, or the owner. */
export function viewerSeesPrivate(viewer: TaskViewer | undefined, ownerId: unknown): boolean {
  if (!viewer) return false;
  if (viewer.isAdmin === true) return true;
  return typeof viewer.userId === 'string' && viewer.userId !== '' && viewer.userId === ownerId;
}

/** The viewer may see this task — a live session or a conversation record (both carry `channelId` and `ownerId`). */
export function canViewTask(
  viewer: TaskViewer | undefined,
  task: { channelId?: unknown; ownerId?: unknown },
  lookup?: PrivacyLookup,
): boolean {
  return !isPrivateTask(task.channelId, lookup) || viewerSeesPrivate(viewer, task.ownerId);
}

/**
 * A board card as this filter reads it. Every card this build makes says `privateTask` (true or false); a card
 * without it came from an instance on an older build, which never said — it counts as private.
 */
export interface VisibleCard {
  privateTask?: boolean;
  ownerId?: string;
  epic?: { children?: VisibleCard[] } | null;
}

/** The viewer may see this card. */
export function canViewCard(viewer: TaskViewer | undefined, card: VisibleCard): boolean {
  return card.privateTask === false || viewerSeesPrivate(viewer, card.ownerId);
}

/**
 * The card as this viewer may see it, or null when they may not. An epic's children are filtered the same way, and a
 * card that did not say whether it is private says it is (the key on its face).
 */
export function cardForViewer<C extends VisibleCard>(card: C, viewer: TaskViewer | undefined): C | null {
  if (!canViewCard(viewer, card)) return null;
  let out: C = card;
  if (card.privateTask !== true && card.privateTask !== false) out = { ...out, privateTask: true };
  const kids = card.epic?.children;
  if (card.epic && Array.isArray(kids)) {
    const shown: VisibleCard[] = [];
    let changed = false;
    for (const kid of kids) {
      const k = kid ? cardForViewer(kid, viewer) : null;
      if (k) shown.push(k);
      if (k !== kid) changed = true;
    }
    if (changed) out = { ...out, epic: { ...card.epic, children: shown } };
  }
  return out;
}

/** Every column of the board as this viewer may see it (the board's own object when nothing is left out). */
export function boardForViewer<B extends object>(board: B, viewer: TaskViewer | undefined): B {
  let out: B | undefined;
  for (const [col, cards] of Object.entries(board)) {
    if (!Array.isArray(cards)) continue;
    const shown: VisibleCard[] = [];
    let changed = false;
    for (const card of cards as VisibleCard[]) {
      const c = card ? cardForViewer(card, viewer) : null;
      if (c) shown.push(c);
      if (c !== card) changed = true;
    }
    if (changed) {
      if (!out) out = { ...board };
      (out as Record<string, unknown>)[col] = shown;
    }
  }
  return out ?? board;
}
