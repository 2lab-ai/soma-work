/**
 * #785 — a dashboard send's ref: the id the panel gave its own pending copy of an
 * instruction. The route accepts it, the recorder keeps it on the user turn the
 * send becomes, and the panel replaces its pending copy by it. Short, no markup.
 */
export function isClientRef(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}
