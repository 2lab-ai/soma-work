# User Settings Specification

## Version
- Document Version: 1.0
- Source File: `src/user-settings-store.ts`
- Last Updated: 2025-12-13

## 1. Overview

사용자 설정 저장소는 사용자별 환경 설정을 파일 기반으로 영속화합니다. 기본 작업 디렉토리, 권한 우회 설정, 페르소나, Jira 계정 매핑 등을 관리합니다.

## 2. Data Model

### 2.1 UserSettings Interface

```typescript
export interface UserSettings {
  userId: string;              // Slack User ID
  defaultDirectory: string;    // 기본 작업 디렉토리
  bypassPermission: boolean;   // 권한 우회 설정
  persona: string;             // 페르소나 파일명 (.md 확장자 제외)
  lastUpdated: string;         // ISO 날짜 문자열

  // Jira 통합
  jiraAccountId?: string;      // Jira Account ID
  jiraName?: string;           // Jira 표시 이름
  slackName?: string;          // Slack 표시 이름
}
```

### 2.2 Slack-Jira Mapping

```typescript
interface SlackJiraMapping {
  [slackId: string]: {
    jiraAccountId: string;
    name: string;
    slackName?: string;
    jiraName?: string;
  };
}
```

## 3. Storage Files

### 3.1 User Settings File

**경로**: `data/user-settings.json`

**구조**:
```json
{
  "U1234567890": {
    "userId": "U1234567890",
    "defaultDirectory": "/Users/dev/Code/my-project",
    "bypassPermission": false,
    "persona": "default",
    "lastUpdated": "2025-12-13T10:30:00.000Z",
    "jiraAccountId": "5f4dcc3b5aa765d61d8327deb882cf99",
    "jiraName": "Hong Gildong",
    "slackName": "홍길동"
  }
}
```

### 3.2 Slack-Jira Mapping File

**경로**: `data/slack_jira_mapping.json`

**구조**:
```json
{
  "U1234567890": {
    "jiraAccountId": "5f4dcc3b5aa765d61d8327deb882cf99",
    "name": "Hong Gildong",
    "slackName": "홍길동",
    "jiraName": "Hong Gildong"
  }
}
```

## 4. Settings Operations

### 4.1 Get User Default Directory

```typescript
getUserDefaultDirectory(userId: string): string | undefined {
  const userSettings = this.settings[userId];
  if (userSettings?.defaultDirectory) {
    return userSettings.defaultDirectory;
  }
  return undefined;
}
```

### 4.2 Set User Default Directory

```typescript
setUserDefaultDirectory(userId: string, directory: string): void {
  const existing = this.settings[userId];
  this.settings[userId] = {
    userId,
    defaultDirectory: directory,
    bypassPermission: existing?.bypassPermission ?? false,
    persona: existing?.persona ?? 'default',
    lastUpdated: new Date().toISOString(),
  };
  this.saveSettings();
}
```

### 4.3 Get Bypass Permission

```typescript
getUserBypassPermission(userId: string): boolean {
  const userSettings = this.settings[userId];
  return userSettings?.bypassPermission ?? false;
}
```

### 4.4 Set Bypass Permission

```typescript
setUserBypassPermission(userId: string, bypass: boolean): void {
  if (this.settings[userId]) {
    this.settings[userId].bypassPermission = bypass;
    this.settings[userId].lastUpdated = new Date().toISOString();
  } else {
    this.settings[userId] = {
      userId,
      defaultDirectory: '',
      bypassPermission: bypass,
      persona: 'default',
      lastUpdated: new Date().toISOString(),
    };
  }
  this.saveSettings();
}
```

### 4.5 Get User Persona

```typescript
getUserPersona(userId: string): string {
  const userSettings = this.settings[userId];
  return userSettings?.persona ?? 'default';
}
```

### 4.6 Set User Persona

```typescript
setUserPersona(userId: string, persona: string): void {
  if (this.settings[userId]) {
    this.settings[userId].persona = persona;
    this.settings[userId].lastUpdated = new Date().toISOString();
  } else {
    this.settings[userId] = {
      userId,
      defaultDirectory: '',
      bypassPermission: false,
      persona,
      lastUpdated: new Date().toISOString(),
    };
  }
  this.saveSettings();
}
```

## 5. Jira Integration

### 5.1 Update Jira Info

```typescript
updateUserJiraInfo(userId: string, slackName?: string): boolean {
  const mapping = this.slackJiraMapping[userId];
  if (!mapping) {
    return false;
  }

  const existing = this.settings[userId];
  const needsUpdate = !existing ||
    existing.jiraAccountId !== mapping.jiraAccountId ||
    existing.jiraName !== mapping.name ||
    (slackName && existing.slackName !== slackName);

  if (needsUpdate) {
    this.settings[userId] = {
      userId,
      defaultDirectory: existing?.defaultDirectory ?? '',
      bypassPermission: existing?.bypassPermission ?? false,
      persona: existing?.persona ?? 'default',
      lastUpdated: new Date().toISOString(),
      jiraAccountId: mapping.jiraAccountId,
      jiraName: mapping.name,
      slackName: slackName || mapping.slackName || existing?.slackName,
    };
    this.saveSettings();
    return true;
  }

  return false;
}
```

### 5.2 Get Jira Account ID

```typescript
getUserJiraAccountId(userId: string): string | undefined {
  return this.settings[userId]?.jiraAccountId;
}
```

### 5.3 Get Jira Name

```typescript
getUserJiraName(userId: string): string | undefined {
  return this.settings[userId]?.jiraName;
}
```

### 5.4 Reload Mapping

```typescript
reloadSlackJiraMapping(): void {
  this.loadSlackJiraMapping();
}
```

## 6. Settings Management

### 6.1 Get All Settings

```typescript
getUserSettings(userId: string): UserSettings | undefined {
  return this.settings[userId];
}
```

### 6.2 Remove Settings

```typescript
removeUserSettings(userId: string): boolean {
  if (this.settings[userId]) {
    delete this.settings[userId];
    this.saveSettings();
    return true;
  }
  return false;
}
```

### 6.3 List Users

```typescript
listUsers(): string[] {
  return Object.keys(this.settings);
}
```

### 6.4 Get Statistics

```typescript
getStats(): { userCount: number; directories: string[] } {
  const directories = [...new Set(
    Object.values(this.settings).map(s => s.defaultDirectory)
  )];
  return {
    userCount: Object.keys(this.settings).length,
    directories,
  };
}
```

## 7. Persistence

### 7.1 Load Settings

```typescript
private loadSettings(): void {
  try {
    if (fs.existsSync(this.settingsFile)) {
      const data = fs.readFileSync(this.settingsFile, 'utf8');
      this.settings = JSON.parse(data);
      logger.info('Loaded user settings', {
        userCount: Object.keys(this.settings).length
      });
    } else {
      this.settings = {};
      logger.info('No existing settings file, starting fresh');
    }
  } catch (error) {
    logger.error('Failed to load user settings', error);
    this.settings = {};
  }
}
```

### 7.2 Save Settings

```typescript
private saveSettings(): void {
  try {
    fs.writeFileSync(
      this.settingsFile,
      JSON.stringify(this.settings, null, 2),
      'utf8'
    );
    logger.debug('Saved user settings to file');
  } catch (error) {
    logger.error('Failed to save user settings', error);
  }
}
```

### 7.3 Load Jira Mapping

```typescript
private loadSlackJiraMapping(): void {
  try {
    if (fs.existsSync(this.mappingFile)) {
      const data = fs.readFileSync(this.mappingFile, 'utf8');
      this.slackJiraMapping = JSON.parse(data);
      logger.info('Loaded Slack-Jira mapping', {
        mappingCount: Object.keys(this.slackJiraMapping).length
      });
    } else {
      this.slackJiraMapping = {};
      logger.info('No Slack-Jira mapping file found');
    }
  } catch (error) {
    logger.error('Failed to load Slack-Jira mapping', error);
    this.slackJiraMapping = {};
  }
}
```

## 8. Commands

### 8.1 Persona Commands

**List Available Personas**:
```
persona
/persona
```

**출력**:
```
🎭 *Available Personas*

Current: `default`

Available:
• `default`
• `chaechae`

To change: `persona <name>`
```

**Set Persona**:
```
persona chaechae
/persona chaechae
```

**출력**:
```
✅ Persona changed to `chaechae`

Your AI assistant will now use this personality.
```

### 8.2 Bypass Commands

**Check Status**:
```
bypass
/bypass
```

**Enable**:
```
bypass on
```

**Disable**:
```
bypass off
```

### 8.3 Directory Commands

**Get Current**:
```
cwd
```

**Set Directory**:
```
cwd project-name
```

## 9. User Context Injection

### 9.1 Get User Info Context

메시지 처리 시 사용자 정보 주입:

```typescript
private getUserInfoContext(userId: string): string | null {
  const settings = userSettingsStore.getUserSettings(userId);
  if (!settings) return null;

  const parts: string[] = [];

  if (settings.slackName) {
    parts.push(`<slack-name>${settings.slackName}</slack-name>`);
  }
  if (settings.jiraName) {
    parts.push(`<jira-name>${settings.jiraName}</jira-name>`);
  }
  if (settings.jiraAccountId) {
    parts.push(`<jira-account-id>${settings.jiraAccountId}</jira-account-id>`);
  }

  if (parts.length === 0) return null;

  return `<user-context>\n  ${parts.join('\n  ')}\n</user-context>`;
}
```

### 9.2 Output Example

```xml
<user-context>
  <slack-name>홍길동</slack-name>
  <jira-name>Hong Gildong</jira-name>
  <jira-account-id>5f4dcc3b5aa765d61d8327deb882cf99</jira-account-id>
</user-context>
```

## 10. Initialization

### 10.1 Singleton Instance

```typescript
// Singleton instance
export const userSettingsStore = new UserSettingsStore();
```

### 10.2 Constructor

```typescript
constructor(dataDir?: string) {
  // 데이터 디렉토리 설정
  const dir = dataDir || path.join(process.cwd(), 'data');

  // 디렉토리 생성
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 파일 경로 설정
  this.settingsFile = path.join(dir, 'user-settings.json');
  this.mappingFile = path.join(dir, 'slack_jira_mapping.json');

  // 설정 로드
  this.loadSettings();
  this.loadSlackJiraMapping();
}
```

## 11. Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    User Message                              │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│   Command?           │        │   Regular Message            │
│   (bypass, persona,  │        └──────────────────────────────┘
│    cwd, etc.)        │                      │
└──────────────────────┘                      │
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│   Update Settings    │        │   Load User Settings         │
│   saveSettings()     │        │   - defaultDirectory         │
└──────────────────────┘        │   - bypassPermission         │
                                │   - persona                  │
                                │   - jiraAccountId            │
                                └──────────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │   Apply to Claude Query      │
                                │   - Working Directory        │
                                │   - Permission Mode          │
                                │   - System Prompt + Persona  │
                                │   - User Context             │
                                └──────────────────────────────┘
```

## 12. Default Values

| Setting | Default Value |
|---------|---------------|
| `defaultDirectory` | `''` (empty) |
| `bypassPermission` | `false` |
| `persona` | `'default'` |
| `jiraAccountId` | `undefined` |
| `jiraName` | `undefined` |
| `slackName` | `undefined` |
