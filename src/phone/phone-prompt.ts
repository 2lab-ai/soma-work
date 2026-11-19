/**
 * The call agent's instructions, in three layers (.prd/30-phone-calls-spec.md D5,
 * .prd/31-phone-calls-architecture.md §4.4): the phone rules every call keeps → the environment's instruction for
 * outbound or inbound calls → this call (who, why, the scenario, who asked).
 */

export interface CallPromptInput {
  direction: 'outbound' | 'inbound';
  peerNumber: string;
  ourNumber: string;
  title?: string;
  purpose?: string;
  scenario?: string;
  /** The environment's instruction for this direction. */
  envPrompt?: string;
  /** Display name or id of the person the call is made for. */
  requester?: string;
  maxMinutes: number;
  now?: Date;
}

/** The first message the dialog gets before an outbound call is answered (its reply is the opening line). */
export const OPENING_CUE =
  '[시스템: 지금 상대에게 신호가 가고 있다. 상대가 전화를 받으면 바로 할 첫 마디만 말하라. 인사와 용건을 한두 문장으로.]';

/** Sent when an inbound call opens and no greeting was prepared. */
export const INBOUND_CUE = '[시스템: 걸려 온 전화를 방금 받았다. 짧게 인사하고 용건을 물어라.]';

/** Sent when the line has been quiet after the agent spoke and the other side seems gone. */
export const SILENCE_CUE = '[시스템: 상대가 한동안 말이 없다. 짧게 확인하거나, 용건이 끝났으면 인사하고 hang_up.]';

/** Sent with the other side's words when they spoke on after the agent had decided to hang up. */
export const HANGUP_CANCELLED_CUE =
  '[시스템: 끊기 전에 상대가 말을 이어 갔다. 통화는 계속된다. 상대 말에 먼저 답하라.]';

/** Sent when the call reaches its time limit. */
export const TIME_UP_CUE = '[시스템: 통화 시간 한도에 닿았다. 한 문장으로 마무리 인사를 하고 hang_up.]';

/**
 * Said when the voice host is doing another job and the call cannot be served: synthesized when the line opens (the
 * host is idle then), played, and the phone put down — no dialog, nothing transcribed.
 */
export const BUSY_NOTICE = {
  inbound: '지금은 전화를 받을 수 없습니다. 잠시 후 다시 걸어 주세요.',
  outbound: '지금은 통화를 이어갈 수 없어 나중에 다시 연락드리겠습니다.',
} as const;

const PHONE_RULES = [
  '너는 지금 전화 통화 중인 음성 에이전트다. 네 말은 음성 합성으로 상대에게 그대로 들린다.',
  '- 상대가 묻거나 부탁하면 그것부터 짧게 답한다. 통화 목적은 그다음에 이어 간다.',
  '- 한 번에 한두 문장, 짧은 구어체로 말한다. 상대가 말할 틈을 준다.',
  '- 마크다운, 목록, 이모지, 괄호 속 지문, 링크를 쓰지 않는다. 숫자와 기호는 소리 내어 읽는 말로 쓴다.',
  '- 상대 말은 받아쓰기라 틀릴 수 있다. 어색하면 발음이 비슷한 말 중 대화 흐름에 맞는 뜻으로 알아듣고 답한다. 받아쓴 글자를 그대로 읽어 주며 확인하지 않는다. 정말 알 수 없을 때만 짧게 되묻는다.',
  '- 상대가 AI냐고 물으면 AI 비서라고 사실대로 답한다. 없는 사실을 지어내지 않는다.',
  '- 목적을 이뤘거나 상대가 통화를 끝내려 하면, 짧게 인사한 뒤 hang_up 도구를 부른다. 인사 없이 끊지 않는다.',
  '- 상대가 이미 답한 확인은 다시 묻지 않는다. 다만 확인에 "네"라고 답한 것만으로는 끊지 않는다.',
  '- 목적을 이뤘고 상대가 "감사합니다", "수고하세요"처럼 마무리하면, 확인을 더 묻지 말고 짧게 인사한 뒤 hang_up을 부른다.',
  '- 상대가 자동응답(ARS)이면 안내를 듣고 send_dtmf 도구로 번호를 누른다.',
  '- [시스템: …]으로 시작하는 메시지는 상대의 말이 아니라 통화 시스템의 알림이다. 그 내용을 상대에게 읽어 주지 않는다.',
].join('\n');

function kst(now: Date): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
}

/** Phone numbers read digit groups, not as one large number: 01012345678 → 010-1234-5678. */
export function formatPhoneNumber(n: string): string {
  const d = n.replace(/\D/g, '');
  if (/^02\d{7,8}$/.test(d))
    return d.length === 9 ? `02-${d.slice(2, 5)}-${d.slice(5)}` : `02-${d.slice(2, 6)}-${d.slice(6)}`;
  if (/^\d{11}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^\d{10}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return n;
}

export function buildCallSystemPrompt(input: CallPromptInput): string {
  const lines: string[] = ['[통화 규칙]', PHONE_RULES];
  if (input.envPrompt?.trim()) lines.push('', '[환경 지시]', input.envPrompt.trim());
  lines.push('', '[이번 통화]');
  lines.push(
    input.direction === 'outbound'
      ? `- 방향: 우리가 건 전화 (우리 번호 ${formatPhoneNumber(input.ourNumber)} → 상대 ${formatPhoneNumber(input.peerNumber)})`
      : `- 방향: 걸려 온 전화 (상대 ${formatPhoneNumber(input.peerNumber)} → 우리 번호 ${formatPhoneNumber(input.ourNumber)})`,
  );
  if (input.title?.trim()) lines.push(`- 제목: ${input.title.trim()}`);
  if (input.requester?.trim()) lines.push(`- 이 통화를 맡긴 사람: ${input.requester.trim()}`);
  lines.push(`- 지금 시각: ${kst(input.now ?? new Date())} (한국 시간)`);
  lines.push(`- 통화 시간 한도: ${input.maxMinutes}분`);
  if (input.purpose?.trim()) lines.push('', '[목적]', input.purpose.trim());
  if (input.scenario?.trim()) lines.push('', '[대화 시나리오]', input.scenario.trim());
  return lines.join('\n');
}

/** The call agent's tools, as the model reads them. */
export const HANG_UP_TOOL = {
  description: '통화를 끝낸다. 마지막 인사를 먼저 말한 뒤에 부른다. 부른 뒤에는 더 말하지 않는다.',
  reason: '끊는 이유(기록용, 짧게)',
  result: '말하던 문장을 마치면 통화를 끊는다. 더 말하지 마라.',
  /** The reply that called it answered out-of-date words (the caller went on talking): the call goes on. */
  cancelled: '상대가 말을 이어가서 끊지 않았다. 이어서 들어오는 상대 말에 답하라.',
};
export const SEND_DTMF_TOOL = {
  description: '상대 자동응답(ARS)에 키패드 번호를 누른다. 예: "1", "1234#".',
  digits: '누를 번호 (0-9, *, #)',
  failed: '키패드를 누를 수 없다.',
  sent: (digits: string) => `${digits}를 눌렀다.`,
};

/** The other side pressed keys. */
export function dtmfCue(digits: string): string {
  return `[시스템: 상대가 키패드 ${digits}를 눌렀다]`;
}

/** An inbound call's agent already said the prepared greeting. */
export function greetedNote(greeting: string): string {
  return `너는 전화를 받자마자 이렇게 인사했다: "${greeting}"`;
}

/** The one-shot summary of a finished call. */
export function callSummaryPrompt(input: {
  title: string;
  purpose?: string;
  transcript: Array<{ role: 'agent' | 'peer'; text: string }>;
}): string {
  const lines = input.transcript.map((l) => `${l.role === 'peer' ? '상대' : '에이전트'}: ${l.text}`).join('\n');
  return `다음 전화 통화를 한국어 두세 문장으로 요약하라. 결과(무엇이 정해졌나, 거절됐나, 다음에 할 일)를 먼저 쓴다. 요약만 출력한다.\n\n제목: ${input.title}\n목적: ${input.purpose ?? '(걸려 온 전화)'}\n\n${lines}`;
}

/** Bare greetings the other side says when it picks up — heard, logged, but not a turn of their own. */
/**
 * Words that only close the call (thanks, goodbye, "I'll hang up"), in any order and number: after the agent's own
 * goodbye they do not keep the line open. Informal endings count ("응, 끊을게", "그래 잘 가").
 */
const GOODBYE_RE =
  /^(?:네네|네|예|응|어|그래|그럼|이만|감사합니다|감사해요|고맙습니다|고마워요|고마워|수고하세요|수고하셨습니다|수고해|들어가세요|들어가|안녕히계세요|안녕히가세요|안녕|잘가요|잘가|끊을게요|끊을께요|끊을게|끊을께|끊겠습니다|끊어요|끊어|알겠습니다|알겠어요|알겠어)+$/;

export function isGoodbye(text: string): boolean {
  return GOODBYE_RE.test(text.replace(/[\s.,!?~…]/g, ''));
}

export function isBareGreeting(text: string): boolean {
  const t = text.replace(/[\s.,!?~…]/g, '');
  return /^(여보세요|네|예|네네|여보세요여보세요|안녕하세요|hello|hi)$/i.test(t);
}
