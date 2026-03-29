import { describe, it, expect } from 'vitest';
import {
  scoreComplexity,
  ComplexityTier,
  ComplexityResult,
} from './complexity-scorer';

describe('complexity-scorer', () => {
  describe('scoreComplexity', () => {
    it('returns a ComplexityResult with score, tier, and signals', () => {
      const result = scoreComplexity('hello');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('tier');
      expect(result).toHaveProperty('signals');
      expect(typeof result.score).toBe('number');
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(result.tier);
      expect(Array.isArray(result.signals)).toBe(true);
    });

    it('scores a simple greeting as LOW (0-4)', () => {
      const result = scoreComplexity('안녕하세요');
      expect(result.score).toBeLessThanOrEqual(4);
      expect(result.tier).toBe('LOW');
    });

    it('scores a short question as LOW', () => {
      const result = scoreComplexity('이 함수가 뭐하는 건가요?');
      expect(result.tier).toBe('LOW');
    });

    it('scores a simple lookup request as LOW with negative signal', () => {
      const result = scoreComplexity('간단히 확인해줘');
      expect(result.tier).toBe('LOW');
      // "간단히" should trigger negative lexical signal
      expect(result.signals.some(s => s.points < 0)).toBe(true);
    });
  });

  describe('lexical signals', () => {
    it('adds points for architecture keywords', () => {
      const result = scoreComplexity(
        '이 서비스의 아키텍처를 설계하고 마이그레이션 계획을 세워줘. 전체 리팩토링이 필요할 수 있어.'
      );
      expect(result.signals.some(s => s.category === 'lexical' && s.name === 'architecture_keywords')).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(3);
    });

    it('adds points for debug keywords', () => {
      const result = scoreComplexity(
        '에러가 발생하고 있어. 크래시 로그를 보면 버그가 있는 것 같아.'
      );
      expect(result.signals.some(s => s.category === 'lexical' && s.name === 'debug_keywords')).toBe(true);
    });

    it('subtracts points for simplicity keywords', () => {
      const result = scoreComplexity('간단히 조회해줘');
      const simpleSig = result.signals.find(s => s.name === 'simplicity_keywords');
      expect(simpleSig).toBeDefined();
      expect(simpleSig!.points).toBeLessThan(0);
    });

    it('adds points for long messages (>200 words)', () => {
      const longMessage = 'word '.repeat(201);
      const result = scoreComplexity(longMessage);
      expect(result.signals.some(s => s.name === 'long_message')).toBe(true);
    });

    it('adds more points for very long messages (>500 words)', () => {
      const veryLongMessage = 'word '.repeat(501);
      const result = scoreComplexity(veryLongMessage);
      const sig = result.signals.find(s => s.name === 'very_long_message');
      expect(sig).toBeDefined();
      expect(sig!.points).toBeGreaterThanOrEqual(3);
    });

    it('adds points for multiple file paths', () => {
      const result = scoreComplexity(
        'src/dispatch-service.ts, src/types.ts, src/session-registry.ts 이 세 파일을 수정해야 해'
      );
      expect(result.signals.some(s => s.name === 'multiple_file_paths')).toBe(true);
    });

    it('adds points for multiple code blocks', () => {
      const result = scoreComplexity(
        '이렇게 바꿔줘:\n```ts\nconst a = 1;\n```\n그리고 이것도:\n```ts\nconst b = 2;\n```'
      );
      expect(result.signals.some(s => s.name === 'multiple_code_blocks')).toBe(true);
    });
  });

  describe('structural signals', () => {
    it('adds points for multiple subtasks (numbered list)', () => {
      const result = scoreComplexity(
        '다음을 해줘:\n1. 타입 정의\n2. 함수 구현\n3. 테스트 작성\n4. 문서화'
      );
      expect(result.signals.some(s => s.name === 'subtasks')).toBe(true);
    });

    it('adds more points for many subtasks (6+)', () => {
      const result = scoreComplexity(
        '1. 타입\n2. 함수\n3. 테스트\n4. 문서\n5. 리뷰\n6. 배포\n7. 모니터링'
      );
      const sig = result.signals.find(s => s.name === 'many_subtasks');
      expect(sig).toBeDefined();
      expect(sig!.points).toBeGreaterThanOrEqual(4);
    });

    it('adds points for cross-file change indicators', () => {
      const result = scoreComplexity(
        '여러 파일에 걸쳐 변경해야 해. cross-cutting concern이라서'
      );
      expect(result.signals.some(s => s.name === 'cross_file_change')).toBe(true);
    });

    it('adds points for test requirement indicators', () => {
      const result = scoreComplexity('구현하고 테스트도 작성해줘');
      expect(result.signals.some(s => s.name === 'test_required')).toBe(true);
    });

    it('adds points for system-wide impact indicators', () => {
      const result = scoreComplexity(
        '전체 시스템에 영향을 미치는 전역 설정 변경이야'
      );
      expect(result.signals.some(s => s.name === 'system_wide_impact')).toBe(true);
    });
  });

  describe('tier classification', () => {
    it('classifies score 0-4 as LOW', () => {
      const result = scoreComplexity('hello');
      expect(result.tier).toBe('LOW');
    });

    it('classifies complex tasks as MEDIUM or HIGH', () => {
      const complexMessage = [
        '전체 아키텍처를 리팩토링해줘.',
        '다음 파일들을 수정해야 해:',
        'src/dispatch-service.ts',
        'src/types.ts',
        'src/session-registry.ts',
        'src/claude-handler.ts',
        '1. 타입 정의 변경',
        '2. 함수 시그니처 변경',
        '3. 호출부 수정',
        '4. 테스트 업데이트',
        '5. 문서 업데이트',
        '6. 빌드 검증',
        '테스트도 작성해줘.',
      ].join('\n');
      const result = scoreComplexity(complexMessage);
      expect(['MEDIUM', 'HIGH']).toContain(result.tier);
      expect(result.score).toBeGreaterThanOrEqual(5);
    });

    it('classifies architecture + many subtasks as HIGH', () => {
      const highComplexity = [
        '마이크로서비스 아키텍처로 마이그레이션 설계를 해줘.',
        '전체 시스템에 영향을 미치는 대규모 리팩토링이야.',
        '여러 파일에 걸친 변경이 필요하고, 되돌리기 어려운 작업이야.',
        '다음을 해야 해:',
        '1. 서비스 분리 설계',
        '2. API 게이트웨이 설정',
        '3. 데이터베이스 스키마 분리',
        '4. 이벤트 버스 구현',
        '5. 서비스 간 통신 프로토콜',
        '6. 배포 파이프라인 변경',
        '7. 모니터링 설정',
        '8. 롤백 전략',
        'src/service-a.ts, src/service-b.ts, src/gateway.ts, src/events.ts 파일을 생성해야 해.',
        '테스트도 반드시 작성해줘.',
      ].join('\n');
      const result = scoreComplexity(highComplexity);
      expect(result.tier).toBe('HIGH');
      expect(result.score).toBeGreaterThanOrEqual(10);
    });
  });

  describe('score floor', () => {
    it('never returns a negative score', () => {
      const result = scoreComplexity('간단히 조회 확인');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
