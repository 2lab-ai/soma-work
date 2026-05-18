# File Handling Specification

## Version
- Document Version: 1.0
- Source File: `src/file-handler.ts`
- Last Updated: 2025-12-13

## 1. Overview

파일 핸들러는 Slack에서 업로드된 파일을 다운로드하고, 처리하며, Claude가 분석할 수 있는 형태로 프롬프트에 포함시킵니다.

## 2. Data Model

### 2.1 ProcessedFile Interface

```typescript
export interface ProcessedFile {
  path: string;           // 임시 저장 경로
  name: string;           // 원본 파일명
  mimetype: string;       // MIME 타입
  isImage: boolean;       // 이미지 파일 여부
  isText: boolean;        // 텍스트 파일 여부
  size: number;           // 파일 크기 (bytes)
  tempPath?: string;      // 정리용 임시 경로
}
```

## 3. File Processing

### 3.1 Download and Process

```typescript
async downloadAndProcessFiles(files: any[]): Promise<ProcessedFile[]> {
  const processedFiles: ProcessedFile[] = [];

  for (const file of files) {
    try {
      const processed = await this.downloadFile(file);
      if (processed) {
        processedFiles.push(processed);
      }
    } catch (error) {
      this.logger.error(`Failed to process file ${file.name}`, error);
    }
  }

  return processedFiles;
}
```

### 3.2 Single File Download

```typescript
private async downloadFile(file: any): Promise<ProcessedFile | null> {
  // 1. 파일 크기 검사 (50MB 제한)
  if (file.size > 50 * 1024 * 1024) {
    this.logger.warn('File too large, skipping', { name: file.name, size: file.size });
    return null;
  }

  // 2. Slack API로 파일 다운로드
  const response = await fetch(file.url_private_download, {
    headers: {
      'Authorization': `Bearer ${config.slack.botToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  // 3. 임시 파일로 저장
  const buffer = await response.buffer();
  const tempDir = os.tmpdir();
  const tempPath = path.join(tempDir, `slack-file-${Date.now()}-${file.name}`);

  fs.writeFileSync(tempPath, buffer);

  // 4. ProcessedFile 객체 생성
  return {
    path: tempPath,
    name: file.name,
    mimetype: file.mimetype,
    isImage: this.isImageFile(file.mimetype),
    isText: this.isTextFile(file.mimetype),
    size: file.size,
    tempPath,
  };
}
```

## 4. File Type Detection

### 4.1 Image Detection

```typescript
private isImageFile(mimetype: string): boolean {
  return mimetype.startsWith('image/');
}
```

**지원 이미지 타입**:
- `image/jpeg` (JPG)
- `image/png` (PNG)
- `image/gif` (GIF)
- `image/webp` (WebP)
- `image/svg+xml` (SVG)

### 4.2 Text Detection

```typescript
private isTextFile(mimetype: string): boolean {
  const textTypes = [
    'text/',                      // text/plain, text/html, text/css, etc.
    'application/json',           // JSON
    'application/javascript',     // JavaScript
    'application/typescript',     // TypeScript
    'application/xml',            // XML
    'application/yaml',           // YAML
    'application/x-yaml',         // YAML (alternative)
  ];

  return textTypes.some(type => mimetype.startsWith(type));
}
```

**지원 텍스트 타입**:

| Category | Extensions |
|----------|-----------|
| Plain Text | `.txt`, `.md`, `.log` |
| Code | `.js`, `.ts`, `.py`, `.java`, `.c`, `.cpp`, `.rs`, `.go` |
| Config | `.json`, `.yaml`, `.yml`, `.xml`, `.toml`, `.ini` |
| Web | `.html`, `.css`, `.scss` |
| Data | `.csv` |

## 5. Prompt Formatting

### 5.1 Format File Prompt

```typescript
async formatFilePrompt(files: ProcessedFile[], userText: string): Promise<string> {
  let prompt = userText || 'Please analyze the uploaded files.';

  if (files.length > 0) {
    prompt += '\n\nUploaded files:\n';

    for (const file of files) {
      if (file.isImage) {
        prompt += this.formatImageFile(file);
      } else if (file.isText) {
        prompt += this.formatTextFile(file);
      } else {
        prompt += this.formatBinaryFile(file);
      }
    }

    prompt += '\nPlease analyze these files and provide insights or assistance based on their content.';
  }

  return prompt;
}
```

### 5.2 Image File Format

```typescript
private formatImageFile(file: ProcessedFile): string {
  return `
## Image: ${file.name}
File type: ${file.mimetype}
Path: ${file.path}
Note: This is an image file that has been uploaded. You can analyze it using the Read tool to examine the image content.
`;
}
```

**출력 예시**:
```
## Image: screenshot.png
File type: image/png
Path: /tmp/slack-file-1702456789123-screenshot.png
Note: This is an image file that has been uploaded. You can analyze it using the Read tool to examine the image content.
```

### 5.3 Text File Format

```typescript
private formatTextFile(file: ProcessedFile): string {
  let prompt = `
## File: ${file.name}
File type: ${file.mimetype}
`;

  try {
    const content = fs.readFileSync(file.path, 'utf-8');

    if (content.length > 10000) {
      prompt += `Content (truncated to first 10000 characters):
\`\`\`
${content.substring(0, 10000)}...
\`\`\`
`;
    } else {
      prompt += `Content:
\`\`\`
${content}
\`\`\`
`;
    }
  } catch (error) {
    prompt += `Error reading file content: ${error}\n`;
  }

  return prompt;
}
```

**출력 예시**:
```
## File: config.json
File type: application/json
Content:
```
{
  "name": "my-project",
  "version": "1.0.0"
}
```
```

### 5.4 Binary File Format

```typescript
private formatBinaryFile(file: ProcessedFile): string {
  return `
## File: ${file.name}
File type: ${file.mimetype}
Size: ${file.size} bytes
Note: This is a binary file. Content analysis may be limited.
`;
}
```

## 6. File Cleanup

### 6.1 Cleanup Method

```typescript
async cleanupTempFiles(files: ProcessedFile[]): Promise<void> {
  for (const file of files) {
    if (file.tempPath) {
      try {
        fs.unlinkSync(file.tempPath);
        this.logger.debug('Cleaned up temp file', { path: file.tempPath });
      } catch (error) {
        this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
      }
    }
  }
}
```

### 6.2 Cleanup Timing

```typescript
// 메시지 처리 완료 후
finally {
  if (processedFiles.length > 0) {
    await this.fileHandler.cleanupTempFiles(processedFiles);
  }
}

// 오류 발생 시에도 정리
catch (error) {
  if (processedFiles.length > 0) {
    await this.fileHandler.cleanupTempFiles(processedFiles);
  }
}
```

## 7. Supported File Types

### 7.1 Method

```typescript
getSupportedFileTypes(): string[] {
  return [
    'Images: jpg, png, gif, webp, svg',
    'Text files: txt, md, json, js, ts, py, java, etc.',
    'Documents: pdf, docx (limited support)',
    'Code files: most programming languages',
  ];
}
```

### 7.2 Full List

| Category | Types | Processing |
|----------|-------|------------|
| Images | JPG, PNG, GIF, WebP, SVG | Path reference (Read tool 사용) |
| Text | TXT, MD, LOG | Content embedded |
| Code | JS, TS, PY, Java, C, C++, Rust, Go | Content embedded |
| Config | JSON, YAML, XML, TOML | Content embedded |
| Documents | PDF, DOCX | Limited/Binary |
| Archives | ZIP, TAR | Binary (metadata only) |

## 8. Size Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max File Size | 50 MB | 단일 파일 최대 크기 |
| Max Text Content | 10,000 chars | 텍스트 파일 내용 최대 길이 |
| Temp File Pattern | `slack-file-{timestamp}-{name}` | 임시 파일명 형식 |

## 9. Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│               Slack File Upload Event                        │
│    files: [{ id, name, mimetype, url_private_download }]    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│           downloadAndProcessFiles()                          │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            │                 │                 │
            ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Size Check     │ │   Download      │ │   Type Check    │
│  (< 50MB)       │ │   via Slack API │ │   (image/text)  │
└─────────────────┘ └─────────────────┘ └─────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                Save to Temp File                             │
│           /tmp/slack-file-{ts}-{name}                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              formatFilePrompt()                              │
│   - Image: Path reference for Read tool                     │
│   - Text: Content embedded (max 10K chars)                  │
│   - Binary: Metadata only                                    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Claude Processing                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              cleanupTempFiles()                              │
│           Delete temporary files                             │
└─────────────────────────────────────────────────────────────┘
```

## 10. Security Considerations

### 10.1 Authentication

```typescript
// Slack Bot Token으로 인증
const response = await fetch(file.url_private_download, {
  headers: {
    'Authorization': `Bearer ${config.slack.botToken}`,
  },
});
```

### 10.2 File Validation

- 파일 크기 제한 (50MB)
- MIME 타입 검증
- 임시 디렉토리 사용 (시스템 tmpdir)

### 10.3 Cleanup

- 처리 완료 후 즉시 삭제
- 오류 발생 시에도 정리 보장
- 고유 타임스탬프로 충돌 방지

## 11. Error Handling

### 11.1 Download Errors

```typescript
try {
  const response = await fetch(...);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
} catch (error) {
  this.logger.error('Failed to download file', error);
  return null;  // 실패한 파일은 건너뜀
}
```

### 11.2 Read Errors

```typescript
try {
  const content = fs.readFileSync(file.path, 'utf-8');
} catch (error) {
  prompt += `Error reading file content: ${error}\n`;
}
```

### 11.3 Cleanup Errors

```typescript
try {
  fs.unlinkSync(file.tempPath);
} catch (error) {
  this.logger.warn('Failed to cleanup temp file', { path: file.tempPath, error });
  // 정리 실패는 경고만 기록 (처리 중단하지 않음)
}
```
