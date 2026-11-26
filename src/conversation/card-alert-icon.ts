/**
 * The hot card's alert (@2lab.ai/ui 0.51.0 `data.alertIcon`): Slack's `:alert:` siren, the red rotating light, in
 * the head of a task card past one core, just before its node pill. The image ships next to this module
 * (`assets/card-alert.gif`, copied there by the build; where it comes from is in `assets/NOTICE.md`) and the
 * dashboard serves it from its own origin (CARD_ALERT_ICON_PATH): no third-party request from the reader's browser.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '../logger';

const logger = new Logger('CardAlertIcon');

/** Where the dashboard serves the alert image. */
export const CARD_ALERT_ICON_PATH = '/dashboard/assets/card-alert.gif';

export interface CardAlertIcon {
  body: Buffer;
  /** The first 12 hex of the image's SHA-256: the `?v=` that lets the browser keep it a year. */
  v: string;
}

let icon: CardAlertIcon | null | undefined;

/** The alert image, read once; null (logged once) when it is missing — the board then hands no URL and cards show 🚨. */
export function cardAlertIcon(): CardAlertIcon | null {
  if (icon === undefined) {
    try {
      const body = readFileSync(join(__dirname, 'assets', 'card-alert.gif'));
      icon = { body, v: createHash('sha256').update(body).digest('hex').slice(0, 12) };
    } catch (err) {
      icon = null;
      logger.warn('The hot card alert image is missing: cards past one core show 🚨', err);
    }
  }
  return icon;
}

/** The URL the board hands @2lab.ai/ui as `data.alertIcon`, versioned by content; '' when the image is missing. */
export function cardAlertIconUrl(): string {
  const found = cardAlertIcon();
  return found ? `${CARD_ALERT_ICON_PATH}?v=${found.v}` : '';
}
