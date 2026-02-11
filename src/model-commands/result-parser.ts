import { ModelCommandListResponse, ModelCommandRunResponse } from './types';

export function parseModelCommandRunResponse(raw: unknown): ModelCommandRunResponse | null {
  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.type !== 'model_command_result') continue;
    if (typeof candidate.commandId !== 'string') continue;
    if (typeof candidate.ok !== 'boolean') continue;
    return candidate as ModelCommandRunResponse;
  }
  return null;
}

export function parseModelCommandListResponse(raw: unknown): ModelCommandListResponse | null {
  const candidates = extractJsonCandidates(raw);
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    if (candidate.type !== 'model_command_list') continue;
    if (!Array.isArray(candidate.commands)) continue;
    return candidate as ModelCommandListResponse;
  }
  return null;
}

export function extractJsonCandidates(raw: unknown): unknown[] {
  const candidates: unknown[] = [];
  collectCandidates(raw, candidates);
  return candidates;
}

function collectCandidates(raw: unknown, target: unknown[]): void {
  if (raw === null || raw === undefined) {
    return;
  }

  if (typeof raw === 'string') {
    const parsed = safeParseJson(raw);
    if (parsed !== null) {
      target.push(parsed);
    }
    return;
  }

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      collectCandidates(entry, target);
    }
    return;
  }

  if (!isRecord(raw)) {
    return;
  }

  target.push(raw);

  if (Array.isArray(raw.content)) {
    for (const item of raw.content) {
      collectCandidates(item, target);
    }
  }

  if (typeof raw.text === 'string') {
    collectCandidates(raw.text, target);
  }

  if (typeof raw.result === 'string') {
    collectCandidates(raw.result, target);
  }
}

function safeParseJson(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
