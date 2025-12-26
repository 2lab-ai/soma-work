import { PendingChoiceFormData } from './types';

/**
 * 폼 상태 관리 (Choice/Form 핸들러 간 공유)
 */
export class PendingFormStore {
  private forms: Map<string, PendingChoiceFormData> = new Map();

  get(formId: string): PendingChoiceFormData | undefined {
    return this.forms.get(formId);
  }

  set(formId: string, data: PendingChoiceFormData): void {
    this.forms.set(formId, data);
  }

  delete(formId: string): void {
    this.forms.delete(formId);
  }

  has(formId: string): boolean {
    return this.forms.has(formId);
  }
}
