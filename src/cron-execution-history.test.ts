/**
 * Cron Execution History — Contract tests
 * Trace: docs/cron-execution-history/trace.md, S1-S3
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CronStorage } from './cron-storage';

describe('Cron Execution History', () => {
  let storage: CronStorage;
  let tmpFile: string;
  let historyFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `cron-hist-test-${Date.now()}.json`);
    historyFile = tmpFile.replace(/\.json$/, '').replace(/cron-hist-test/, 'cron-history');
    // historyFilePath is derived from filePath by replacing cron-jobs.json → cron-history.json
    // So we need our tmpFile to end with cron-jobs.json
    tmpFile = path.join(os.tmpdir(), `test-${Date.now()}`, 'cron-jobs.json');
    historyFile = tmpFile.replace('cron-jobs.json', 'cron-history.json');
    storage = new CronStorage(tmpFile);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {}
    try {
      fs.unlinkSync(tmpFile + '.tmp');
    } catch {}
    try {
      fs.unlinkSync(historyFile);
    } catch {}
    try {
      fs.unlinkSync(historyFile + '.tmp');
    } catch {}
    try {
      fs.rmdirSync(path.dirname(tmpFile));
    } catch {}
  });

  // --- S1: Record execution on cron fire ---

  describe('S1: Record execution on cron fire', () => {
    it('should record successful idle injection', () => {
      storage.addExecution({
        jobId: 'job-1',
        jobName: 'test-job',
        status: 'success',
        executionPath: 'idle_inject',
        sessionKey: 'C123-1234567890.123',
      });
      const history = storage.getExecutionHistory('test-job');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('success');
      expect(history[0].executionPath).toBe('idle_inject');
      expect(history[0].executedAt).toBeDefined();
      expect(history[0].sessionKey).toBe('C123-1234567890.123');
    });

    it('should record failed execution with error', () => {
      storage.addExecution({
        jobId: 'job-1',
        jobName: 'test-job',
        status: 'failed',
        executionPath: 'new_thread',
        error: 'Thread creation failed',
      });
      const history = storage.getExecutionHistory('test-job');
      expect(history[0].status).toBe('failed');
      expect(history[0].error).toBe('Thread creation failed');
    });

    it('should record queued status for busy sessions', () => {
      storage.addExecution({
        jobId: 'job-1',
        jobName: 'test-job',
        status: 'queued',
        executionPath: 'busy_queue',
        sessionKey: 'C123-1234567890.123',
      });
      const history = storage.getExecutionHistory('test-job');
      expect(history[0].status).toBe('queued');
      expect(history[0].executionPath).toBe('busy_queue');
    });
  });

  // --- S2: cron_history query ---

  describe('S2: cron_history query', () => {
    it('should return history for a specific job', () => {
      storage.addExecution({ jobId: 'j1', jobName: 'job-a', status: 'success', executionPath: 'idle_inject' });
      storage.addExecution({ jobId: 'j2', jobName: 'job-b', status: 'success', executionPath: 'new_thread' });
      storage.addExecution({
        jobId: 'j1',
        jobName: 'job-a',
        status: 'failed',
        executionPath: 'new_thread',
        error: 'fail',
      });

      const history = storage.getExecutionHistory('job-a');
      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0].status).toBe('failed');
      expect(history[1].status).toBe('success');
    });

    it('should return all history when no name specified', () => {
      storage.addExecution({ jobId: 'j1', jobName: 'job-a', status: 'success', executionPath: 'idle_inject' });
      storage.addExecution({ jobId: 'j2', jobName: 'job-b', status: 'success', executionPath: 'new_thread' });

      const history = storage.getExecutionHistory();
      expect(history).toHaveLength(2);
    });

    it('should respect limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        storage.addExecution({ jobId: 'j1', jobName: 'test', status: 'success', executionPath: 'idle_inject' });
      }
      const history = storage.getExecutionHistory('test', undefined, 3);
      expect(history).toHaveLength(3);
    });

    it('should return empty array when no history exists', () => {
      const history = storage.getExecutionHistory('nonexistent');
      expect(history).toHaveLength(0);
    });
  });

  // --- S3: FIFO trim ---

  describe('S3: History FIFO trim (20 per job)', () => {
    it('should keep only last 20 records per job', () => {
      for (let i = 0; i < 25; i++) {
        storage.addExecution({
          jobId: 'j1',
          jobName: 'test',
          status: 'success',
          executionPath: 'idle_inject',
        });
      }
      const history = storage.getExecutionHistory('test');
      expect(history).toHaveLength(20);
    });

    it('should not trim other jobs when one overflows', () => {
      for (let i = 0; i < 25; i++) {
        storage.addExecution({ jobId: 'j1', jobName: 'job-a', status: 'success', executionPath: 'idle_inject' });
      }
      storage.addExecution({ jobId: 'j2', jobName: 'job-b', status: 'success', executionPath: 'new_thread' });

      expect(storage.getExecutionHistory('job-a')).toHaveLength(20);
      expect(storage.getExecutionHistory('job-b')).toHaveLength(1);
    });
  });
});
