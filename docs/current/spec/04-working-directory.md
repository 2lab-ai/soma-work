# Working Directory Management Specification

## Version
- Document Version: 1.0
- Source File: `src/working-directory-manager.ts`
- Last Updated: 2025-12-13

## 1. Overview

작업 디렉토리 관리자는 Claude가 작업할 파일 시스템 경로를 설정하고 해석합니다. 채널별 기본값, 스레드별 오버라이드, 사용자별 기본값을 지원합니다.

## 2. Data Model

### 2.1 WorkingDirectoryConfig Interface

```typescript
export interface WorkingDirectoryConfig {
  channelId: string;      // Slack 채널 ID
  threadTs?: string;      // 스레드 타임스탬프 (스레드 전용 설정인 경우)
  userId?: string;        // 사용자 ID (DM 전용)
  directory: string;      // 절대 경로
  setAt: Date;            // 설정 시간
}
```

## 3. Priority Hierarchy

### 3.1 Resolution Order

1. **Thread-specific**: 스레드에 설정된 디렉토리 (최우선)
2. **Channel/DM**: 채널 또는 DM에 설정된 디렉토리
3. **User Default**: 사용자의 저장된 기본 디렉토리

### 3.2 Config Key Generation

```typescript
getConfigKey(channelId: string, threadTs?: string, userId?: string): string {
  if (threadTs) {
    return `${channelId}-${threadTs}`;  // 스레드 특정
  }
  if (userId && channelId.startsWith('D')) {
    return `${channelId}-${userId}`;     // DM
  }
  return channelId;                       // 채널 전체
}
```

## 4. Directory Resolution

### 4.1 Resolution Process

```typescript
private resolveDirectory(directory: string): string | null {
  // 1. 절대 경로인 경우 직접 사용
  if (path.isAbsolute(directory)) {
    if (fs.existsSync(directory)) {
      return path.resolve(directory);
    }
    return null;
  }

  // 2. Base Directory가 설정된 경우 상대 경로 해석
  if (config.baseDirectory) {
    const baseRelativePath = path.join(config.baseDirectory, directory);
    if (fs.existsSync(baseRelativePath)) {
      return path.resolve(baseRelativePath);
    }
    // 존재하지 않으면 생성 시도
    try {
      fs.mkdirSync(baseRelativePath, { recursive: true });
      return path.resolve(baseRelativePath);
    } catch (error) {
      // 생성 실패
    }
  }

  // 3. CWD 기준 상대 경로
  const cwdRelativePath = path.resolve(directory);
  if (fs.existsSync(cwdRelativePath)) {
    return cwdRelativePath;
  }

  // 4. 존재하지 않으면 생성 시도
  try {
    fs.mkdirSync(cwdRelativePath, { recursive: true });
    return cwdRelativePath;
  } catch (error) {
    // 생성 실패
  }

  return null;
}
```

### 4.2 Resolution Examples

| Input | Base Directory | Result |
|-------|---------------|--------|
| `/Users/dev/project` | (any) | `/Users/dev/project` |
| `my-project` | `/Users/dev/Code` | `/Users/dev/Code/my-project` |
| `my-project` | (none) | `<cwd>/my-project` |
| `./subfolder` | `/Users/dev/Code` | `/Users/dev/Code/subfolder` |

## 5. Set Working Directory

### 5.1 Method Signature

```typescript
setWorkingDirectory(
  channelId: string,
  directory: string,
  threadTs?: string,
  userId?: string
): { success: boolean; resolvedPath?: string; error?: string }
```

### 5.2 Validation Process

```typescript
setWorkingDirectory(channelId, directory, threadTs, userId) {
  try {
    // 1. 경로 해석
    const resolvedPath = this.resolveDirectory(directory);
    if (!resolvedPath) {
      return {
        success: false,
        error: `Directory not found: "${directory}"`
      };
    }

    // 2. 디렉토리 확인
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return { success: false, error: 'Path is not a directory' };
    }

    // 3. 설정 저장
    const key = this.getConfigKey(channelId, threadTs, userId);
    this.configs.set(key, {
      channelId,
      threadTs,
      userId,
      directory: resolvedPath,
      setAt: new Date(),
    });

    // 4. 사용자 기본값으로 저장
    if (userId) {
      userSettingsStore.setUserDefaultDirectory(userId, resolvedPath);
    }

    return { success: true, resolvedPath };
  } catch (error) {
    return {
      success: false,
      error: 'Directory does not exist or is not accessible'
    };
  }
}
```

## 6. Get Working Directory

### 6.1 Method Signature

```typescript
getWorkingDirectory(
  channelId: string,
  threadTs?: string,
  userId?: string
): string | undefined
```

### 6.2 Resolution Logic

```typescript
getWorkingDirectory(channelId, threadTs, userId) {
  // Priority 1: Thread-specific
  if (threadTs) {
    const threadKey = this.getConfigKey(channelId, threadTs);
    const threadConfig = this.configs.get(threadKey);
    if (threadConfig) {
      return threadConfig.directory;
    }
  }

  // Priority 2: Channel/DM
  const channelKey = this.getConfigKey(channelId, undefined, userId);
  const channelConfig = this.configs.get(channelKey);
  if (channelConfig) {
    return channelConfig.directory;
  }

  // Priority 3: User default
  if (userId) {
    const userDefault = userSettingsStore.getUserDefaultDirectory(userId);
    if (userDefault) {
      // 디렉토리가 없으면 생성
      if (!fs.existsSync(userDefault)) {
        fs.mkdirSync(userDefault, { recursive: true });
      }
      // 현재 컨텍스트에 자동 적용
      this.setWorkingDirectoryInternal(channelId, userDefault, threadTs, userId);
      return userDefault;
    }
  }

  return undefined;
}
```

## 7. Command Parsing

### 7.1 Set Command

```typescript
parseSetCommand(text: string): string | null {
  // cwd path 또는 /cwd path
  const cwdMatch = text.match(/^\/?cwd\s+(.+)$/i);
  if (cwdMatch) {
    return cwdMatch[1].trim();
  }

  // set cwd|dir|directory|working-directory path
  const setMatch = text.match(
    /^\/?set\s+(?:cwd|dir|directory|working[- ]?directory)\s+(.+)$/i
  );
  if (setMatch) {
    return setMatch[1].trim();
  }

  return null;
}
```

**지원 형식**:
- `cwd project-name`
- `/cwd project-name`
- `cwd /absolute/path`
- `set cwd project-name`
- `set directory /absolute/path`
- `set working-directory project-name`

### 7.2 Get Command

```typescript
isGetCommand(text: string): boolean {
  return /^\/?(?:get\s+)?(?:cwd|dir|directory|working[- ]?directory)(?:\?)?$/i
    .test(text.trim());
}
```

**지원 형식**:
- `cwd`
- `/cwd`
- `cwd?`
- `get cwd`
- `directory`
- `working-directory`

## 8. Response Messages

### 8.1 Set Success

```
✅ Working directory set for this thread: `/Users/dev/Code/my-project`
_This will be your default for future conversations._
```

### 8.2 Set Failure

```
❌ Directory not found: "invalid-project" (checked in base directory: /Users/dev/Code)
```

### 8.3 Get with Directory Set

```
Current working directory for this channel: `/Users/dev/Code/my-project`

Base directory: `/Users/dev/Code`
You can use relative paths like `cwd project-name` or absolute paths.
```

### 8.4 Get without Directory

```
No working directory set for this channel. Please set one using:
`cwd project-name` (relative to base directory)
`cwd /absolute/path/to/directory` (absolute path)

Base directory: `/Users/dev/Code`
```

### 8.5 No Directory Error (Message Handling)

```
⚠️ No working directory set. Please set a default working directory for this channel first using:
`cwd project-name` or `cwd /absolute/path`

Base directory: `/Users/dev/Code`
```

## 9. Channel Setup Flow

### 9.1 Welcome Message Format

```typescript
formatChannelSetupMessage(channelId: string, channelName: string): string {
  let message = `🏠 **Channel Working Directory Setup**\n\n`;
  message += `Please set the default working directory for #${channelName}:\n\n`;

  if (hasBaseDir) {
    message += `**Options:**\n`;
    message += `• \`cwd project-name\` (relative to: \`${config.baseDirectory}\`)\n`;
    message += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
  } else {
    message += `**Usage:**\n`;
    message += `• \`cwd /path/to/project\`\n`;
    message += `• \`set directory /path/to/project\`\n\n`;
  }

  message += `This becomes the default for all conversations in this channel.\n`;
  message += `Individual threads can override this by mentioning me with a different \`cwd\` command.`;

  return message;
}
```

## 10. Base Directory

### 10.1 Configuration

```env
BASE_DIRECTORY=/Users/username/Code/
```

### 10.2 Usage Benefits

- 짧은 프로젝트 이름으로 경로 지정 가능
- 일관된 프로젝트 구조 유지
- 오타 방지 및 편의성 향상

### 10.3 Without Base Directory

Base Directory가 설정되지 않은 경우:
- 절대 경로만 사용 가능
- 상대 경로는 프로세스 CWD 기준으로 해석

## 11. User Default Persistence

### 11.1 Save Default

```typescript
// setWorkingDirectory 내부에서 호출
if (userId) {
  userSettingsStore.setUserDefaultDirectory(userId, resolvedPath);
}
```

### 11.2 Auto-Apply

사용자가 새 대화를 시작할 때:

```typescript
// getWorkingDirectory에서 자동 적용
const userDefault = userSettingsStore.getUserDefaultDirectory(userId);
if (userDefault) {
  this.setWorkingDirectoryInternal(channelId, userDefault, threadTs, userId);
  return userDefault;
}
```

## 12. Flow Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    User Input                            │
│              "cwd my-project"                            │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│                parseSetCommand()                         │
│            Extract: "my-project"                         │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│              resolveDirectory()                          │
│    1. Check absolute? No                                 │
│    2. BASE_DIR + "my-project" exists? Yes               │
│    Result: "/Users/dev/Code/my-project"                 │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│            setWorkingDirectory()                         │
│    1. Validate directory                                 │
│    2. Store config                                       │
│    3. Save user default                                  │
└──────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────┐
│              Response to User                            │
│    "✅ Working directory set: /Users/dev/Code/my-project"│
└──────────────────────────────────────────────────────────┘
```
