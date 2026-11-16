/**
 * #1315 — a task whose channel the registry does not say is public is a private task: its owner's and the admins'
 * only (task-visibility.ts). A test whose fixture has another signed-in user read or act on a task in a made-up
 * channel registers that channel as a public one first. No name and no repo: the card the test reads is the card it
 * read before (card-where.ts shows a public channel's name and repo only when the registry has them).
 *
 * Call it after the test's `vi.resetModules()` and imports, so it reaches the registry the dashboard reads.
 */
export async function registerPublicChannel(...channelIds: string[]): Promise<void> {
  const { upsertChannel } = await import('../../channel-registry');
  for (const id of channelIds) upsertChannel({ id, name: '', isPrivate: false });
}
