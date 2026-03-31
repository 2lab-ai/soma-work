import {
  copyBackupCredentials,
  getCredentialStatus,
  hasClaudeAiOauth,
  isCredentialManagerEnabled,
} from '../../credentials-manager';
import { Logger } from '../../logger';
import { CommandParser } from '../command-parser';
import type { CommandContext, CommandHandler, CommandResult } from './types';

/**
 * Handles credential restore command
 */
export class RestoreHandler implements CommandHandler {
  private logger = new Logger('RestoreHandler');

  canHandle(text: string): boolean {
    return CommandParser.isRestoreCommand(text);
  }

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const { threadTs, say } = ctx;

    // Check if credential manager is enabled
    if (!isCredentialManagerEnabled()) {
      await say({
        text: '⚠️ Credential manager is disabled.\n\nTo enable, set `ENABLE_LOCAL_FILE_CREDENTIALS_JSON=1` in your environment.',
        thread_ts: threadTs,
      });
      return { handled: true };
    }

    // Get status before restore
    const beforeStatus = getCredentialStatus();

    // Format before status message
    const beforeLines: string[] = [
      '🔑 *Credential Restore*',
      '',
      '*현재 상태 (복사 전):*',
      `• 크레덴셜 파일 존재 (\`.credentials.json\`): ${beforeStatus.credentialsFileExists ? '✅' : '❌'}`,
      `• 백업 파일 존재 (\`credentials.json\`): ${beforeStatus.backupFileExists ? '✅' : '❌'}`,
      `• claudeAiOauth 존재: ${beforeStatus.hasClaudeAiOauth ? '✅' : '❌'}`,
      `• 자동 복원 활성화: ${beforeStatus.autoRestoreEnabled ? '✅' : '❌'}`,
    ];

    await say({
      text: beforeLines.join('\n'),
      thread_ts: threadTs,
    });

    // Attempt to copy backup credentials
    this.logger.info('Attempting credential restore via command');
    const copySuccess = copyBackupCredentials();

    // Get status after restore
    const afterHasOauth = hasClaudeAiOauth();
    const afterStatus = getCredentialStatus();

    // Format result message
    const resultLines: string[] = [];

    if (copySuccess) {
      resultLines.push('✅ *복사 완료*');
      resultLines.push('');
      resultLines.push('`~/.claude/credentials.json` → `~/.claude/.credentials.json`');
    } else {
      resultLines.push('❌ *복사 실패*');
      resultLines.push('');
      if (!beforeStatus.backupFileExists) {
        resultLines.push('백업 파일 (`credentials.json`)이 존재하지 않습니다.');
      } else {
        resultLines.push('파일 복사 중 오류가 발생했습니다.');
      }
    }

    resultLines.push('');
    resultLines.push('*복사 후 상태:*');
    resultLines.push(`• 크레덴셜 파일 존재: ${afterStatus.credentialsFileExists ? '✅' : '❌'}`);
    resultLines.push(`• claudeAiOauth 존재: ${afterHasOauth ? '✅' : '❌'}`);

    if (afterHasOauth) {
      resultLines.push('');
      resultLines.push('🎉 Claude 인증이 정상적으로 설정되었습니다!');
    } else if (copySuccess) {
      resultLines.push('');
      resultLines.push('⚠️ 파일은 복사되었지만 claudeAiOauth가 없습니다.');
      resultLines.push('`claude login` 명령어로 다시 로그인해주세요.');
    }

    await say({
      text: resultLines.join('\n'),
      thread_ts: threadTs,
    });

    this.logger.info('Credential restore command completed', {
      copySuccess,
      beforeHadOauth: beforeStatus.hasClaudeAiOauth,
      afterHasOauth,
    });

    return { handled: true };
  }
}
