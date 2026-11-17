/**
 * Production wiring of the phone (.prd/31-phone-calls-architecture.md §2): the daemon calls
 * {@link startPhoneService} once at boot; it opens a line for every server-tools environment with a `phone`
 * section and does nothing at all when there is none.
 */

import * as fs from 'node:fs';
import { buildOneShotOptions, runOneShotText } from '../agent-runtime';
import { auxModelFor } from '../agent-runtime/aux-model';
import { openVoiceDialog } from '../agent-runtime/voice-dialog';
import { buildQueryEnv } from '../auth/query-env-builder';
import { userTenantKey } from '../auth/user-tenant-key';
import { substituteEnvVars } from '../config-env-substitution';
import { ensureActiveSlotAuth } from '../credentials-manager';
import { CONFIG_FILE, SECRETS_DIR } from '../env-paths';
import { Logger } from '../logger';
import { getTokenManager } from '../token-manager';
import { userSettingsStore } from '../user-settings-store';
import type { PhoneCallRecord } from './call-store';
import { loadKoreaAiTelSdk } from './koreaaitel';
import { callSummaryPrompt } from './phone-prompt';
import { type DialogAuth, PhoneService } from './phone-service';
import { getPhoneCallStore, PHONE_DIR } from './store-instance';

export { getPhoneCallStore, PHONE_DIR } from './store-instance';

const logger = new Logger('Phone');

function readServerTools(): Record<string, unknown> | null {
  if (!CONFIG_FILE) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const section = substituteEnvVars(parsed).value?.['server-tools'];
    return section && typeof section === 'object' ? (section as Record<string, unknown>) : null;
  } catch (err) {
    logger.warn('phone: config.json unreadable', { error: (err as Error).message });
    return null;
  }
}

/** `{"$secret": name}` → the secret's value. The bot process reads the store; no model does (.prd/25 §2). */
function resolveSecrets<T>(value: T): T {
  // Typed locally: `moduleResolution: node` does not see @soma/process-shared's sub-path types.
  // biome-ignore lint/style/noCommonJs: see above
  const ref = require('@soma/process-shared/secret-ref.js') as {
    resolveSecretRefs<V>(v: V, dir: string | undefined): V;
  };
  return ref.resolveSecretRefs(value, SECRETS_DIR);
}

async function dialogAuth(input: { requester?: string; model?: string }): Promise<DialogAuth> {
  const lease = await ensureActiveSlotAuth(getTokenManager(), 'phone-call');
  try {
    const { env } = buildQueryEnv(lease, { llmuxTenant: await userTenantKey(input.requester) });
    let model: string;
    let effort: string | undefined;
    if (input.model) {
      model = userSettingsStore.resolveModelInput(input.model) ?? input.model;
    } else {
      const aux = auxModelFor('sonnet', { userId: input.requester });
      model = aux.model;
      effort = aux.effort;
    }
    return { env, model, effort, release: () => lease.release() };
  } catch (err) {
    await lease.release();
    throw err;
  }
}

/** Two or three sentences on how the call went — the card's and the owner notice's summary line. */
async function summarize(record: PhoneCallRecord): Promise<string | null> {
  const lease = await ensureActiveSlotAuth(getTokenManager(), 'phone-summary').catch(() => null);
  if (!lease) return null;
  try {
    const { env } = buildQueryEnv(lease, { llmuxTenant: await userTenantKey(record.requester) });
    const aux = auxModelFor('haiku', { userId: record.requester });
    const prompt = callSummaryPrompt({
      title: record.title,
      purpose: record.purpose,
      transcript: record.transcript.slice(-80),
    });
    const text = await runOneShotText(
      prompt,
      buildOneShotOptions({
        model: aux.model,
        effort: aux.effort,
        systemPrompt: 'You summarize phone calls. Output only the summary.',
        env,
        logger,
        stderrLabel: 'PhoneSummary',
      }),
    );
    return text.trim().slice(0, 600) || null;
  } catch (err) {
    logger.warn('phone: summary failed', { error: (err as Error).message });
    return null;
  } finally {
    await lease.release();
  }
}

export interface StartPhoneServiceInput {
  notifyOwner?: (userId: string, text: string) => Promise<void>;
  dashboardUrl?: () => string | undefined;
}

/**
 * Start the phone service. It opens the configured lines now and follows config.json afterwards (a line added later
 * — or its secret put in place later — opens within 30 s), so it always runs; the SDK is loaded only when a line
 * opens.
 */
export function startPhoneService(input: StartPhoneServiceInput = {}): PhoneService {
  const sdk = (): ReturnType<typeof loadKoreaAiTelSdk> => loadKoreaAiTelSdk();
  const service = new PhoneService({
    sdk: {
      createAgent: (o) => sdk().createAgent(o),
      ulawToPcm16: (b) => sdk().ulawToPcm16(b),
      pcm16ToUlaw: (b) => sdk().pcm16ToUlaw(b),
    },
    store: getPhoneCallStore(),
    phoneDir: PHONE_DIR,
    readServerTools,
    resolveSecrets,
    dialogAuth,
    openDialog: (opts) =>
      openVoiceDialog({
        ...opts,
        onStderr: (line) => logger.warn('phone dialog stderr', { line: line.trimEnd().slice(0, 500) }),
      }),
    summarize,
    notifyOwner: input.notifyOwner,
    dashboardUrl: input.dashboardUrl,
    log: (level, message, data) => logger[level](message, data),
  });
  // In the background: a phone platform that is slow or down must never hold up the bot's boot.
  service
    .start()
    .then(() => {
      if (service.environments.length) logger.info('phone: service started', { lines: service.environments });
    })
    .catch((err) => logger.warn('phone: service did not start', { error: (err as Error).message }));
  return service;
}
