import dotenv from 'dotenv';
import { WebClient } from '@slack/web-api';

dotenv.config();

// Preflight check results
export interface PreflightResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN!,
    appToken: process.env.SLACK_APP_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '', // Optional - only needed if not using Claude subscription
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  credentials: {
    enabled: process.env.ENABLE_LOCAL_FILE_CREDENTIALS_JSON === '1',
    autoRestore: process.env.AUTOMATIC_RESTORE_CREDENTIAL === '1',
    alertChannel: process.env.CREDENTIAL_ALERT_CHANNEL || '#backend-general',
  },
  baseDirectory: process.env.BASE_DIRECTORY || '',
  github: {
    appId: process.env.GITHUB_APP_ID || '',
    privateKey: process.env.GITHUB_PRIVATE_KEY || '',
    installationId: process.env.GITHUB_INSTALLATION_ID || '',
    token: process.env.GITHUB_TOKEN || '',
  },
  debug: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',
};

export function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    // ANTHROPIC_API_KEY is optional - only needed if not using Claude subscription
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Log if using Claude subscription vs API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[Config] Using Claude subscription (no API key provided)');
  } else {
    console.log('[Config] Using Anthropic API key');
  }
}

/**
 * Comprehensive preflight checks for environment configuration
 * Returns detailed errors and warnings
 */
export async function runPreflightChecks(): Promise<PreflightResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  console.log('\n🔍 Running preflight checks...\n');

  // ===== 1. Slack Token Format Validation =====
  const slackBotToken = process.env.SLACK_BOT_TOKEN || '';
  const slackAppToken = process.env.SLACK_APP_TOKEN || '';
  const slackSigningSecret = process.env.SLACK_SIGNING_SECRET || '';

  // Bot token format
  if (!slackBotToken) {
    errors.push('❌ SLACK_BOT_TOKEN: Missing');
  } else if (!slackBotToken.startsWith('xoxb-')) {
    errors.push(`❌ SLACK_BOT_TOKEN: Invalid format (should start with "xoxb-", got "${slackBotToken.substring(0, 10)}...")`);
  } else {
    console.log('✅ SLACK_BOT_TOKEN: Format OK (xoxb-...)');
  }

  // App token format (Socket Mode)
  if (!slackAppToken) {
    errors.push('❌ SLACK_APP_TOKEN: Missing');
  } else if (!slackAppToken.startsWith('xapp-')) {
    errors.push(`❌ SLACK_APP_TOKEN: Invalid format (should start with "xapp-", got "${slackAppToken.substring(0, 10)}...")`);
  } else {
    console.log('✅ SLACK_APP_TOKEN: Format OK (xapp-...)');
  }

  // Signing secret
  if (!slackSigningSecret) {
    errors.push('❌ SLACK_SIGNING_SECRET: Missing');
  } else if (slackSigningSecret.length < 20) {
    warnings.push(`⚠️ SLACK_SIGNING_SECRET: Unusually short (${slackSigningSecret.length} chars)`);
  } else {
    console.log('✅ SLACK_SIGNING_SECRET: Present');
  }

  // ===== 2. Slack API Connection Test =====
  if (slackBotToken && slackBotToken.startsWith('xoxb-')) {
    try {
      const client = new WebClient(slackBotToken);
      const authResult = await client.auth.test();
      if (authResult.ok) {
        console.log(`✅ Slack API: Connected as @${authResult.user} (bot_id: ${authResult.bot_id})`);
        console.log(`   Team: ${authResult.team} (${authResult.team_id})`);
      } else {
        errors.push(`❌ Slack API: auth.test failed - ${authResult.error}`);
      }
    } catch (err: any) {
      errors.push(`❌ Slack API: Connection failed - ${err.message}`);
      if (err.message.includes('invalid_auth')) {
        errors.push('   → Token is invalid or revoked. Regenerate in Slack App settings.');
      }
    }
  }

  // ===== 3. Anthropic API Key Validation =====
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  if (!anthropicKey) {
    warnings.push('⚠️ ANTHROPIC_API_KEY: Not set (using Claude subscription)');
  } else if (!anthropicKey.startsWith('sk-ant-')) {
    warnings.push(`⚠️ ANTHROPIC_API_KEY: Unusual format (expected "sk-ant-...", got "${anthropicKey.substring(0, 10)}...")`);
  } else {
    console.log('✅ ANTHROPIC_API_KEY: Format OK (sk-ant-...)');
  }

  // ===== 4. GitHub Configuration =====
  const githubAppId = process.env.GITHUB_APP_ID || '';
  const githubPrivateKey = process.env.GITHUB_PRIVATE_KEY || '';
  const githubInstallationId = process.env.GITHUB_INSTALLATION_ID || '';
  const githubToken = process.env.GITHUB_TOKEN || '';

  if (githubAppId || githubPrivateKey || githubInstallationId) {
    // GitHub App mode
    if (!githubAppId) {
      errors.push('❌ GITHUB_APP_ID: Missing (required for GitHub App auth)');
    } else {
      console.log(`✅ GITHUB_APP_ID: ${githubAppId}`);
    }

    if (!githubPrivateKey) {
      errors.push('❌ GITHUB_PRIVATE_KEY: Missing (required for GitHub App auth)');
    } else if (!githubPrivateKey.includes('BEGIN') || !githubPrivateKey.includes('PRIVATE KEY')) {
      errors.push('❌ GITHUB_PRIVATE_KEY: Invalid format (should be PEM format with BEGIN/END markers)');
    } else {
      console.log('✅ GITHUB_PRIVATE_KEY: Format OK (PEM)');
    }

    if (!githubInstallationId) {
      warnings.push('⚠️ GITHUB_INSTALLATION_ID: Not set (will auto-discover)');
    } else {
      console.log(`✅ GITHUB_INSTALLATION_ID: ${githubInstallationId}`);
    }
  } else if (githubToken) {
    // PAT mode
    if (!githubToken.startsWith('ghp_') && !githubToken.startsWith('github_pat_')) {
      warnings.push(`⚠️ GITHUB_TOKEN: Unusual format (expected "ghp_..." or "github_pat_...")`);
    } else {
      console.log('✅ GITHUB_TOKEN: Using Personal Access Token');
    }
  } else {
    warnings.push('⚠️ GitHub: No authentication configured (GitHub features disabled)');
  }

  // ===== 5. Base Directory =====
  const baseDir = process.env.BASE_DIRECTORY || '';
  if (!baseDir) {
    warnings.push('⚠️ BASE_DIRECTORY: Not set (using /tmp as fallback)');
  } else {
    const fs = await import('fs');
    if (!fs.existsSync(baseDir)) {
      errors.push(`❌ BASE_DIRECTORY: Path does not exist: ${baseDir}`);
    } else {
      console.log(`✅ BASE_DIRECTORY: ${baseDir}`);
    }
  }

  // ===== 6. Print Summary =====
  console.log('\n' + '='.repeat(50));
  if (errors.length === 0 && warnings.length === 0) {
    console.log('✅ All preflight checks passed!\n');
  } else {
    if (errors.length > 0) {
      console.log(`\n🚫 ERRORS (${errors.length}):`);
      errors.forEach((e) => console.log(`   ${e}`));
    }
    if (warnings.length > 0) {
      console.log(`\n⚠️ WARNINGS (${warnings.length}):`);
      warnings.forEach((w) => console.log(`   ${w}`));
    }
    console.log('');
  }
  console.log('='.repeat(50) + '\n');

  return {
    success: errors.length === 0,
    errors,
    warnings,
  };
}