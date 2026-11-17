/**
 * The daemon's one phone call store. Kept apart from `index.ts` so the dashboard can read calls without loading
 * the phone runtime (the SDK, the dialog) — and old calls stay readable when no line is configured.
 */

import * as path from 'node:path';
import { DATA_DIR } from '../env-paths';
import { PhoneCallStore } from './call-store';

export const PHONE_DIR = path.join(DATA_DIR, 'phone');

let store: PhoneCallStore | undefined;

export function getPhoneCallStore(): PhoneCallStore {
  if (!store) store = new PhoneCallStore(PHONE_DIR);
  return store;
}
