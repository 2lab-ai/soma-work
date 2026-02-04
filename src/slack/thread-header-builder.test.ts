import { describe, it, expect } from 'vitest';
import { ThreadHeaderBuilder } from './thread-header-builder';

describe('ThreadHeaderBuilder', () => {
  it('maps activity state to label and color', () => {
    expect(ThreadHeaderBuilder.getStatusStyle('working')).toEqual({
      label: '작업 중',
      color: '#F2C744',
      emoji: '⚙️',
    });
    expect(ThreadHeaderBuilder.getStatusStyle('waiting')).toEqual({
      label: '입력 대기',
      color: '#3B82F6',
      emoji: '✋',
    });
    expect(ThreadHeaderBuilder.getStatusStyle('idle')).toEqual({
      label: '대기',
      color: '#36a64f',
      emoji: '✅',
    });
  });
});
