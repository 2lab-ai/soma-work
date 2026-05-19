import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '@soma/common/env-paths';
import { Logger } from '@soma/common/logger';
import type { UserChoiceQuestion } from '../user-choice-extractor';

export interface PendingChoiceFormData {
  formId: string;
  sessionKey: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  questions: UserChoiceQuestion[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
  /** P3 (PHASE>=3) turn id that owns this form. */
  turnId?: string;
  /** Submission lock for hero "Submit All Recommended". */
  submitting?: boolean;
}

let getDataDir: () => string = () => DATA_DIR;

export function setPendingFormStoreDataDirProvider(provider: () => string): void {
  getDataDir = provider;
}

function formsFile(): string {
  return path.join(getDataDir(), 'pending-forms.json');
}

// Form timeout: 24 hours (same as session timeout).
const FORM_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * File-backed form state shared between choice/form handlers.
 */
export class PendingFormStore {
  private forms: Map<string, PendingChoiceFormData> = new Map();
  private logger = new Logger('PendingFormStore');

  get(formId: string): PendingChoiceFormData | undefined {
    return this.forms.get(formId);
  }

  set(formId: string, data: PendingChoiceFormData): void {
    this.forms.set(formId, data);
    this.saveForms();
  }

  delete(formId: string): void {
    this.forms.delete(formId);
    this.saveForms();
  }

  has(formId: string): boolean {
    return this.forms.has(formId);
  }

  /**
   * Get all forms for a specific session.
   */
  getFormsBySession(sessionKey: string): Map<string, PendingChoiceFormData> {
    const sessionForms = new Map<string, PendingChoiceFormData>();
    for (const [formId, form] of this.forms) {
      if (form.sessionKey === sessionKey) {
        sessionForms.set(formId, form);
      }
    }
    return sessionForms;
  }

  /**
   * Save all forms to file for persistence across restarts.
   */
  saveForms(): void {
    try {
      fs.mkdirSync(getDataDir(), { recursive: true });

      const formsArray = Array.from(this.forms.entries()).map(([id, form]) => ({
        id,
        ...form,
      }));

      fs.writeFileSync(formsFile(), JSON.stringify(formsArray, null, 2));
      this.logger.debug(`Saved ${formsArray.length} forms to file`);
    } catch (error) {
      this.logger.error('Failed to save forms', error);
    }
  }

  /**
   * Load forms from file after restart.
   */
  loadForms(): number {
    const file = formsFile();
    if (!fs.existsSync(file)) {
      this.logger.debug('No forms file found');
      return 0;
    }

    try {
      const data = fs.readFileSync(file, 'utf-8');
      const formsArray = JSON.parse(data);
      const now = Date.now();

      const validForms = formsArray.filter((formData: any) => {
        const formAge = now - (formData.createdAt || 0);
        return formAge < FORM_TIMEOUT;
      });

      for (const formData of validForms) {
        const { id, ...form } = formData;
        this.forms.set(id, form as PendingChoiceFormData);
      }

      const expiredCount = formsArray.length - validForms.length;
      this.logger.info(`Loaded ${validForms.length} forms from file (${expiredCount} expired)`);

      if (expiredCount > 0) {
        this.saveForms();
      }

      return validForms.length;
    } catch (error) {
      this.logger.error('Failed to load forms', error);
      return 0;
    }
  }
}
