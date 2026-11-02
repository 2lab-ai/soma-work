/**
 * 작업 카드의 연결 (SSOT 2026-11-02 goal: "작업 카드에 디폴트로 표시해야 하는 중요한 것: 연결된 이슈(지라 혹은
 * 깃허브 이슈)들과 이슈 상태, 연결된 PR들과 머지 상태, 연결된 위키들").
 *
 * What the board sends per card for its `links` row (@2lab.ai/ui 0.19.0 `card.links`): every page the session is
 * linked to, each with a short reference and, for issues and PRs, its state in words. First the current issue, PR
 * and wiki (the active link of each kind, else its newest), then the rest of each kind newest first — so the face's
 * first chips always hold one of each kind, however many issues came before.
 *
 * A PR's state is the live one the Slack thread surface checked (`actionPanel.prStatus`, when it was fetched for
 * this URL and the link has not been re-recorded since — as ActionPanelBuilder.livePrStatus), else the fetched one
 * (`peek`, the link-metadata cache), else the one recorded with the link; a merge, which never goes back, wins from
 * any of them. An issue's is the fetched one, else the recorded one. A wiki has none.
 */

export type CardLinkKind = 'issue' | 'pr' | 'wiki';
export type CardLinkTone = 'run' | 'done' | 'fail' | 'wait';

export interface CardLink {
  kind: CardLinkKind;
  url: string;
  /** Short reference: `PROJ-12`, `#41`, `#733`, a wiki page's title. */
  text: string;
  /** The page's own title, when known (the tooltip). */
  title?: string;
  /** The state in words: `열림`, `머지됨`, `In Progress`. */
  status?: string;
  tone?: CardLinkTone;
}

interface LinkLike {
  url?: string;
  type?: string;
  provider?: string;
  label?: string;
  title?: string;
  status?: string;
}

export interface CardLinkSource {
  links?: { issue?: LinkLike; pr?: LinkLike; doc?: LinkLike };
  linkHistory?: { issues?: LinkLike[]; prs?: LinkLike[]; docs?: LinkLike[] };
  actionPanel?: {
    prStatus?: {
      state?: string;
      merged?: boolean;
      draft?: boolean;
      fetchedForUrl?: string;
      linkStatusAtFetch?: string;
    };
  };
}

/** The link-metadata cache's answer for a URL (title and state), if it has one. */
export type LinkPeek = (url: string) => { title?: string; status?: string } | undefined;

/** A card shows at most this many links (the face draws six, then +N). */
export const MAX_CARD_LINKS = 20;
const MAX_TEXT = 40;

const PR_WORDS: Record<string, { status: string; tone?: CardLinkTone }> = {
  open: { status: '열림', tone: 'run' },
  draft: { status: '초안' },
  merged: { status: '머지됨', tone: 'done' },
  closed: { status: '닫힘', tone: 'fail' },
};
const GITHUB_ISSUE_WORDS: Record<string, { status: string; tone?: CardLinkTone }> = {
  open: { status: '열림', tone: 'run' },
  closed: { status: '닫힘', tone: 'done' },
};
// A tracker's own status name (Jira's, mostly), toned by what kind of state it names.
const DONE_RE = /^(done|closed|resolved|complete(d)?|fixed|released|완료|종료|해결(됨)?|닫힘)$/i;
const RUN_RE = /(progress|develop|doing|working|진행|개발)/i;
const WAIT_RE = /(review|qa|test|verif|검토|리뷰|확인|대기|blocked|hold)/i;

/** A link's state in words and its tone. Unknown words are shown as they are. */
export function linkState(kind: CardLinkKind, raw: string | undefined): { status?: string; tone?: CardLinkTone } {
  const word = typeof raw === 'string' ? raw.trim() : '';
  if (!word || kind === 'wiki') return {};
  const key = word.toLowerCase();
  if (kind === 'pr') return PR_WORDS[key] ? { ...PR_WORDS[key] } : { status: word };
  if (GITHUB_ISSUE_WORDS[key]) return { ...GITHUB_ISSUE_WORDS[key] };
  if (DONE_RE.test(word)) return { status: word, tone: 'done' };
  if (WAIT_RE.test(word)) return { status: word, tone: 'wait' };
  if (RUN_RE.test(word)) return { status: word, tone: 'run' };
  return { status: word };
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);
const nonBlank = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';

function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug.replace(/\+/g, ' ')).replace(/[-_]+/g, ' ').trim();
  } catch {
    return slug;
  }
}

/** The short reference a card shows for a link. */
function shortText(kind: CardLinkKind, link: LinkLike, title: string | undefined): string {
  const url = String(link.url);
  if (kind === 'issue') {
    const jira = url.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (jira) return jira[1];
    const gh = url.match(/\/issues\/(\d+)(?:[/?#]|$)/);
    if (gh) return `#${gh[1]}`;
    const linear = url.match(/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+-\d+)/i);
    if (linear) return linear[1].toUpperCase();
    return clip(nonBlank(link.label) ? link.label.trim() : 'Issue');
  }
  if (kind === 'pr') {
    const gh = url.match(/\/pull\/(\d+)(?:[/?#]|$)/);
    if (gh) return `#${gh[1]}`;
    const gl = url.match(/\/merge_requests\/(\d+)(?:[/?#]|$)/);
    if (gl) return `!${gl[1]}`;
    return clip(nonBlank(link.label) ? link.label.trim() : 'PR');
  }
  if (nonBlank(title)) return clip(title.trim());
  const page = url.match(/\/pages\/\d+\/([^/?#]+)/);
  if (page) return clip(decodeSlug(page[1]));
  return clip(nonBlank(link.label) ? link.label.trim() : 'Wiki');
}

function livePrState(src: CardLinkSource, link: LinkLike): string | undefined {
  const live = src.actionPanel?.prStatus;
  if (!live || live.fetchedForUrl !== link.url) return undefined;
  // A check made before the link was recorded again is not this link's (ActionPanelBuilder.livePrStatus).
  if ((live.linkStatusAtFetch ?? '') !== (link.status ?? '')) return undefined;
  if (live.merged) return 'merged';
  if (live.draft && live.state !== 'closed') return 'draft';
  return nonBlank(live.state) ? live.state : undefined;
}

const KINDS: Array<{ kind: CardLinkKind; active: 'issue' | 'pr' | 'doc'; history: 'issues' | 'prs' | 'docs' }> = [
  { kind: 'issue', active: 'issue', history: 'issues' },
  { kind: 'pr', active: 'pr', history: 'prs' },
  { kind: 'wiki', active: 'doc', history: 'docs' },
];

/** Every page the session is linked to, as the card's links. */
export function cardLinksOf(src: CardLinkSource, peek?: LinkPeek): CardLink[] {
  const lists = KINDS.map(({ kind, active, history }) => {
    const list = Array.isArray(src.linkHistory?.[history]) ? src.linkHistory![history]!.slice().reverse() : [];
    const activeLink = src.links?.[active];
    // The active link first, then the history newest first; the history's copy of a URL adds what it knows.
    const ordered: LinkLike[] = [];
    const seen = new Set<string>();
    for (const link of activeLink ? [activeLink, ...list] : list) {
      const url = link && typeof link.url === 'string' ? link.url.trim() : '';
      if (!/^https?:\/\/\S+$/i.test(url) || seen.has(url)) continue;
      seen.add(url);
      ordered.push({ ...list.find((l) => l?.url === url), ...link, url });
    }
    return { kind, ordered, active: activeLink && typeof activeLink.url === 'string' ? activeLink : undefined };
  });
  const out: CardLink[] = [];
  const seen = new Set<string>();
  const push = (kind: CardLinkKind, link: LinkLike, isActive: boolean) => {
    const url = link.url as string;
    if (seen.has(url) || out.length >= MAX_CARD_LINKS) return;
    seen.add(url);
    const cached = peek ? peek(url) : undefined;
    const title = nonBlank(cached?.title) ? cached!.title : nonBlank(link.title) ? link.title : undefined;
    let raw: string | undefined;
    if (kind === 'pr') {
      const states = [isActive ? livePrState(src, link) : undefined, cached?.status, link.status];
      raw = states.some((x) => nonBlank(x) && x.trim().toLowerCase() === 'merged') ? 'merged' : states.find(nonBlank);
    } else if (kind === 'issue') {
      raw = cached?.status || link.status;
    }
    out.push({
      kind,
      url,
      text: shortText(kind, link, kind === 'wiki' ? title : undefined),
      ...(title ? { title: title.trim().slice(0, 200) } : {}),
      ...linkState(kind, raw),
    });
  };
  // The current one of each kind, then the rest of each kind.
  for (const { kind, ordered, active } of lists) {
    if (ordered[0]) push(kind, ordered[0], !!active && active.url?.trim() === ordered[0].url);
  }
  // The rest share what room is left fairly (each kind its turn, one at a time), still drawn kind by kind.
  const rest = lists.map((l) => l.ordered.slice(1));
  const quota = rest.map(() => 0);
  let room = MAX_CARD_LINKS - out.length;
  let open = rest.map((_, i) => i).filter((i) => rest[i].length > 0);
  while (room > 0 && open.length > 0) {
    for (const i of open) {
      if (room === 0) break;
      quota[i]++;
      room--;
    }
    open = open.filter((i) => quota[i] < rest[i].length);
  }
  lists.forEach(({ kind }, i) => {
    for (const link of rest[i].slice(0, quota[i])) push(kind, link, false);
  });
  return out;
}
