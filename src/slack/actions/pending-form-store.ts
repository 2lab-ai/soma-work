import { PendingChoiceFormData } from './types';
import { Logger } from '../../logger';
import * as path from 'path';
import * as fs from 'fs';

// Persistence file path
const DATA_DIR = path.join(process.cwd(), 'data');
const FORMS_FILE = path.join(DATA_DIR, 'pending-forms.json');

// Form timeout: 24 hours (same as session timeout)
const FORM_TIMEOUT = 24 * 60 * 60 * 1000;

/**
 * 폼 상태 관리 (Choice/Form 핸들러 간 공유)
 * 파일 기반 영속성 지원 - 서버 재시작 후에도 폼 상태 유지
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
   * Get all forms for a specific session
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
   * Save all forms to file for persistence across restarts
   */
  saveForms(): void {
    try {
      // Ensure data directory exists
      fs.mkdirSync(DATA_DIR, { recursive: true });

      const formsArray = Array.from(this.forms.entries()).map(([id, form]) => ({
        id,
        ...form,
      }));

      fs.writeFileSync(FORMS_FILE, JSON.stringify(formsArray, null, 2));
      this.logger.debug(`Saved ${formsArray.length} forms to file`);
    } catch (error) {
      this.logger.error('Failed to save forms', error);
    }
  }

  /**
   * Load forms from file after restart
   */
  loadForms(): number {
    if (!fs.existsSync(FORMS_FILE)) {
      this.logger.debug('No forms file found');
      return 0;
    }

    try {
      const data = fs.readFileSync(FORMS_FILE, 'utf-8');
      const formsArray = JSON.parse(data);
      const now = Date.now();

      // Only restore non-expired forms
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

      // Clean up expired forms from file
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
