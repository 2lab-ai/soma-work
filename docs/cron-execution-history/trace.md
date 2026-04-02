# Cron Execution History — Trace

> STV Trace | Created: 2026-04-02 | Spec: docs/cron-execution-history/spec.md

## Implementation Status

| # | Scenario | Size | Status | Test File |
|---|----------|------|--------|-----------|
| S1 | Record execution on cron fire | small | 🔴 RED | `mcp-servers/_shared/cron-storage.test.ts` |
| S2 | MCP cron_history tool | small | 🔴 RED | `mcp-servers/cron/cron-mcp-server.test.ts` |
| S3 | History FIFO trim (20 per job) | tiny | 🔴 RED | `mcp-servers/_shared/cron-storage.test.ts` |

---

## S1: Record Execution on Cron Fire

### 1. Trigger
CronScheduler.executeJob() 완료 시점

### 2. Input
```typescript
{
  jobId: "uuid",
  jobName: "es-2min",
  status: "success" | "failed" | "queued",
  executionPath: "idle_inject" | "busy_queue" | "new_thread",
  error?: "error message",
  sessionKey?: "C0AKY-1234567890.123456"
}
```

### 3. Call Stack

```
CronScheduler.tick()
  → CronScheduler.executeJob(job, now)
    → [idle path] CronScheduler.injectMessage(job, session, now)
      → deps.messageInjector(syntheticEvent)
      → deps.storage.updateLastRun(job.id, now)
      → deps.storage.addExecution({                    ← NEW
          jobId: job.id,
          jobName: job.name,
          status: 'success',
          executionPath: 'idle_inject',
          sessionKey: `${session.channelId}-${session.threadTs}`
        })
    → [busy path] CronScheduler.enqueueForIdle(job, session, now)
      → deps.storage.addExecution({                    ← NEW
          jobId: job.id,
          jobName: job.name,
          status: 'queued',
          executionPath: 'busy_queue',
          sessionKey
        })
    → [no-session path] CronScheduler.executeWithNewThread(job, now)
      → deps.threadCreator(job.channel, text)
      → deps.messageInjector(syntheticEvent)
      → deps.storage.addExecution({                    ← NEW
          jobId: job.id,
          jobName: job.name,
          status: 'success',
          executionPath: 'new_thread',
          sessionKey: `${job.channel}-${rootTs}`
        })
    → [error path] catch in tick()
      → deps.storage.addExecution({                    ← NEW
          jobId: job.id,
          jobName: job.name,
          status: 'failed',
          executionPath: determined by context,
          error: error.message
        })
```

### 4. Affected Files

| File | Change |
|------|--------|
| `mcp-servers/_shared/cron-storage.ts` | Add `CronExecutionRecord`, `addExecution()`, `getExecutionHistory()` |
| `src/cron-scheduler.ts` (→ dist/) | Call `addExecution()` at each execution path |

### 5. Contract Test (RED)

```typescript
describe('S1: Record execution on cron fire', () => {
  it('should record successful idle injection', () => {
    const storage = new CronStorage(tmpPath);
    storage.addExecution({
      jobId: 'job-1', jobName: 'test-job',
      status: 'success', executionPath: 'idle_inject',
      sessionKey: 'C123-1234567890.123'
    });
    const history = storage.getExecutionHistory('test-job');
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('success');
    expect(history[0].executionPath).toBe('idle_inject');
    expect(history[0].executedAt).toBeDefined();
  });

  it('should record failed execution with error', () => {
    const storage = new CronStorage(tmpPath);
    storage.addExecution({
      jobId: 'job-1', jobName: 'test-job',
      status: 'failed', executionPath: 'new_thread',
      error: 'Thread creation failed'
    });
    const history = storage.getExecutionHistory('test-job');
    expect(history[0].status).toBe('failed');
    expect(history[0].error).toBe('Thread creation failed');
  });

  it('should record queued status for busy sessions', () => {
    const storage = new CronStorage(tmpPath);
    storage.addExecution({
      jobId: 'job-1', jobName: 'test-job',
      status: 'queued', executionPath: 'busy_queue',
      sessionKey: 'C123-1234567890.123'
    });
    const history = storage.getExecutionHistory('test-job');
    expect(history[0].status).toBe('queued');
  });
});
```

### 6. Dependencies
- CronStorage (existing)
- CronScheduler (existing, dist/ only — no .ts source)

### 7. Risks
- CronScheduler는 dist/에만 있으므로 .ts 소스 생성 필요 (또는 dist/ 직접 수정)
- Storage addExecution에서 파일 I/O 실패 시 cron 실행 자체에 영향 없어야 함 (catch+warn)

---

## S2: MCP cron_history Tool

### 1. Trigger
모델이 `cron_history` MCP 도구 호출

### 2. Input
```typescript
{ name?: string, limit?: number }
```

### 3. Call Stack

```
Model → MCP CallTool("cron_history", { name: "es-2min", limit: 5 })
  → CronMcpServer.handleTool("cron_history", args)
    → handleHistory(args, context, storage)
      → storage.getExecutionHistory(name, ownerFilter, limit)
      → format results as markdown table
      → return { text, isError: false }
```

### 4. Affected Files

| File | Change |
|------|--------|
| `mcp-servers/cron/cron-mcp-server.ts` | Add `cron_history` tool definition + handler |
| `mcp-servers/_shared/cron-storage.ts` | `getExecutionHistory(name?, owner?, limit?)` |

### 5. Contract Test (RED)

```typescript
describe('S2: MCP cron_history tool', () => {
  it('should return execution history for a specific job', () => {
    const storage = new CronStorage(tmpPath);
    const job = storage.addJob({ name: 'test', expression: '* * * * *', prompt: 'hi', owner: 'U1', channel: 'C1', threadTs: null });
    storage.addExecution({ jobId: job.id, jobName: 'test', status: 'success', executionPath: 'idle_inject' });
    storage.addExecution({ jobId: job.id, jobName: 'test', status: 'failed', executionPath: 'new_thread', error: 'fail' });

    const history = storage.getExecutionHistory('test', 'U1');
    expect(history).toHaveLength(2);
    // Most recent first
    expect(history[0].status).toBe('failed');
    expect(history[1].status).toBe('success');
  });

  it('should return all history when no name specified', () => {
    const storage = new CronStorage(tmpPath);
    storage.addExecution({ jobId: 'j1', jobName: 'job-a', status: 'success', executionPath: 'idle_inject' });
    storage.addExecution({ jobId: 'j2', jobName: 'job-b', status: 'success', executionPath: 'new_thread' });

    const history = storage.getExecutionHistory(undefined, 'U1');
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('should respect limit parameter', () => {
    const storage = new CronStorage(tmpPath);
    for (let i = 0; i < 10; i++) {
      storage.addExecution({ jobId: 'j1', jobName: 'test', status: 'success', executionPath: 'idle_inject' });
    }
    const history = storage.getExecutionHistory('test', undefined, 3);
    expect(history).toHaveLength(3);
  });
});
```

### 6. Dependencies
- CronStorage.getExecutionHistory() (S1)

### 7. Risks
- None — follows existing MCP tool pattern exactly

---

## S3: History FIFO Trim (20 per Job)

### 1. Trigger
`CronStorage.addExecution()` 호출 시 자동

### 2. Input
N/A (addExecution 내부 로직)

### 3. Call Stack

```
CronStorage.addExecution(record)
  → load cron-history.json
  → push record to history array
  → group by jobId, trim each group to MAX_HISTORY_PER_JOB (20)  ← NEW
  → atomic save cron-history.json
```

### 4. Affected Files

| File | Change |
|------|--------|
| `mcp-servers/_shared/cron-storage.ts` | FIFO trim in `addExecution()` |

### 5. Contract Test (RED)

```typescript
describe('S3: History FIFO trim', () => {
  it('should keep only last 20 records per job', () => {
    const storage = new CronStorage(tmpPath);
    for (let i = 0; i < 25; i++) {
      storage.addExecution({
        jobId: 'j1', jobName: 'test',
        status: 'success', executionPath: 'idle_inject'
      });
    }
    const history = storage.getExecutionHistory('test');
    expect(history).toHaveLength(20);
  });

  it('should not trim other jobs when one overflows', () => {
    const storage = new CronStorage(tmpPath);
    for (let i = 0; i < 25; i++) {
      storage.addExecution({ jobId: 'j1', jobName: 'job-a', status: 'success', executionPath: 'idle_inject' });
    }
    storage.addExecution({ jobId: 'j2', jobName: 'job-b', status: 'success', executionPath: 'new_thread' });

    expect(storage.getExecutionHistory('job-a')).toHaveLength(20);
    expect(storage.getExecutionHistory('job-b')).toHaveLength(1);
  });
});
```

### 6. Dependencies
- S1 (addExecution method)

### 7. Risks
- None — simple array slice
