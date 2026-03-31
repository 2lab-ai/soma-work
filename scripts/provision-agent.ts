#!/usr/bin/env npx tsx

/**
 * provision-agent.ts — Automated Slack App provisioning for sub-agents
 *
 * Automates:
 *   1. App creation via apps.manifest.create
 *   2. OAuth install via local callback server → captures bot token (xoxb-)
 *   3. Guides user to create app-level token (xapp-) with direct link
 *   4. Updates config.json automatically
 *   5. Creates prompt directory with default prompt
 *
 * Prerequisites:
 *   - Configuration Token stored in config.json under "configurationToken"
 *   - One-time: generate at https://api.slack.com/apps → "Your App Configuration Tokens"
 *
 * Usage:
 *   npx tsx scripts/provision-agent.ts <agent-name> [description]
 *
 * Example:
 *   npx tsx scripts/provision-agent.ts gwanu "배포 및 인프라 전문 에이전트"
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

// ── Constants ──────────────────────────────────────────────
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');
const OAUTH_CALLBACK_PORT = 39847; // Ephemeral-ish port for OAuth callback
const OAUTH_CALLBACK_PATH = '/oauth/callback';
const OAUTH_REDIRECT_URI = `http://localhost:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`;
const SLACK_API_BASE = 'https://slack.com/api';

// Bot scopes matching the main bot (minus slash commands and assistant:write)
const BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'channels:read',
  'chat:write',
  'chat:write.public',
  'files:read',
  'files:write',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'users:read',
  'reactions:read',
  'reactions:write',
];

// ── Colors ──────────────────────────────────────────────────
const C = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[0;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
};

function info(msg: string) {
  console.log(`${C.blue}ℹ${C.reset}  ${msg}`);
}
function ok(msg: string) {
  console.log(`${C.green}✓${C.reset}  ${msg}`);
}
function warn(msg: string) {
  console.log(`${C.yellow}⚠${C.reset}  ${msg}`);
}
function err(msg: string) {
  console.error(`${C.red}✗${C.reset}  ${msg}`);
}
function step(n: number, total: number, label: string) {
  console.log(`\n${C.bold}${C.cyan}── Step ${n}/${total}: ${label} ──${C.reset}`);
}

// ── Slack API helpers ────────────────────────────────────────

async function slackApi(method: string, body: Record<string, any>, token?: string): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error}${data.detail ? ` — ${data.detail}` : ''}`);
  }
  return data;
}

// ── Configuration Token Management ───────────────────────────

interface ConfigTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number; // Unix timestamp
}

function loadConfigTokens(config: any): ConfigTokens | null {
  const ct = config.configurationToken;
  if (!ct) return null;
  return {
    accessToken: ct.accessToken || ct.access_token || '',
    refreshToken: ct.refreshToken || ct.refresh_token || '',
    expiresAt: ct.expiresAt || ct.expires_at,
  };
}

async function rotateConfigToken(tokens: ConfigTokens): Promise<ConfigTokens> {
  info('Rotating configuration token...');
  const data = await slackApi('tooling.tokens.rotate', {
    refresh_token: tokens.refreshToken,
  });

  const newTokens: ConfigTokens = {
    accessToken: data.token,
    refreshToken: data.refresh_token,
    expiresAt: data.exp,
  };

  ok(`Token rotated. Expires: ${new Date((newTokens.expiresAt || 0) * 1000).toISOString()}`);
  return newTokens;
}

async function getValidConfigToken(config: any): Promise<{ token: string; config: any }> {
  let tokens = loadConfigTokens(config);

  if (!tokens || !tokens.accessToken) {
    err('Configuration token not found in config.json.');
    console.log(`
  ${C.bold}One-time setup required:${C.reset}
  1. Go to ${C.cyan}https://api.slack.com/apps${C.reset}
  2. Scroll to ${C.bold}"Your App Configuration Tokens"${C.reset}
  3. Click ${C.bold}"Generate Token"${C.reset} → select your workspace
  4. Copy the access token and refresh token
  5. Add to config.json:
     ${C.cyan}"configurationToken": {
       "accessToken": "xoxe.xoxp-...",
       "refreshToken": "xoxe-..."
     }${C.reset}
`);
    process.exit(1);
  }

  // Check if token is expired or will expire within 1 hour
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = tokens.expiresAt || 0;
  if (expiresAt > 0 && expiresAt - now < 3600) {
    tokens = await rotateConfigToken(tokens);
    // Update config in memory
    config.configurationToken = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    };
    // Persist
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    ok('Config token saved to config.json');
  }

  return { token: tokens.accessToken, config };
}

// ── Manifest Builder ─────────────────────────────────────────

function buildManifest(agentName: string, description: string): object {
  const displayName = `soma-${agentName}`;
  return {
    display_information: {
      name: displayName,
      description,
      background_color: '#4A154B',
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: {
        display_name: displayName,
        always_online: true,
      },
    },
    oauth_config: {
      redirect_urls: [OAUTH_REDIRECT_URI],
      scopes: {
        bot: BOT_SCOPES,
      },
    },
    settings: {
      event_subscriptions: {
        bot_events: ['app_mention', 'message.im'],
      },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// ── OAuth Callback Server ────────────────────────────────────

function startOAuthCallbackServer(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<{ botToken: string; teamId: string; botUserId: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('OAuth callback timed out after 5 minutes'));
    }, 300_000);

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '', `http://localhost:${OAUTH_CALLBACK_PORT}`);

      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>❌ Installation cancelled</h1><p>You can close this tab.</p></body></html>');
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth denied: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code parameter');
        return;
      }

      try {
        // Exchange code for bot token
        const tokenRes = await fetch(`${SLACK_API_BASE}/oauth.v2.access`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });

        const tokenData = (await tokenRes.json()) as any;

        if (!tokenData.ok) {
          throw new Error(`oauth.v2.access failed: ${tokenData.error}`);
        }

        const botToken = tokenData.access_token;
        const teamId = tokenData.team?.id || '';
        const botUserId = tokenData.bot_user_id || '';

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
          <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>✅ Bot installed successfully!</h1>
            <p>Bot token captured. You can close this tab.</p>
            <p style="color: #666;">Return to your terminal to continue setup.</p>
          </body></html>
        `);

        clearTimeout(timeout);
        server.close();
        resolve({ botToken, teamId, botUserId });
      } catch (e) {
        res.writeHead(500);
        res.end(`Error: ${e}`);
        clearTimeout(timeout);
        server.close();
        reject(e);
      }
    });

    server.listen(OAUTH_CALLBACK_PORT, () => {
      info(`OAuth callback server listening on port ${OAUTH_CALLBACK_PORT}`);
    });
  });
}

// ── Prompt Directory ─────────────────────────────────────────

function createPromptDir(agentName: string, description: string): string {
  const promptDir = path.join(PROJECT_ROOT, 'src', 'prompt', agentName);
  if (fs.existsSync(promptDir)) {
    warn(`Prompt directory already exists: ${promptDir}`);
    return promptDir;
  }

  fs.mkdirSync(promptDir, { recursive: true });
  const promptContent = `# ${agentName} — Sub-Agent System Prompt

${description}

{{include:../common.prompt}}
`;
  fs.writeFileSync(path.join(promptDir, 'default.prompt'), promptContent, 'utf-8');
  ok(`Created prompt: ${promptDir}/default.prompt`);
  return promptDir;
}

// ── readline helper ──────────────────────────────────────────

function ask(question: string): Promise<string> {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const agentName = process.argv[2];
  const description = process.argv[3] || 'AI Sub-Agent';

  if (!agentName) {
    err('Usage: npx tsx scripts/provision-agent.ts <agent-name> [description]');
    err('Example: npx tsx scripts/provision-agent.ts gwanu "배포 및 인프라 전문 에이전트"');
    process.exit(1);
  }

  if (!/^[a-z][a-z0-9-]*$/.test(agentName)) {
    err('Agent name must be lowercase alphanumeric (a-z, 0-9, -), starting with a letter');
    process.exit(1);
  }

  console.log(`
${C.bold}🤖 Provisioning Sub-Agent: ${agentName}${C.reset}
   Display Name: soma-${agentName}
   Description:  ${description}
`);

  // Load config
  let config: any = {};
  if (fs.existsSync(CONFIG_FILE)) {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }

  // Check if agent already exists
  if (config.agents?.[agentName]) {
    err(`Agent '${agentName}' already exists in config.json. Remove it first to re-provision.`);
    process.exit(1);
  }

  const TOTAL_STEPS = 5;

  // ── Step 1: Validate configuration token ──────────────────
  step(1, TOTAL_STEPS, 'Validate Configuration Token');
  const { token: configToken, config: updatedConfig } = await getValidConfigToken(config);
  config = updatedConfig;
  ok('Configuration token is valid');

  // ── Step 2: Create Slack App ──────────────────────────────
  step(2, TOTAL_STEPS, 'Create Slack App via Manifest API');
  const manifest = buildManifest(agentName, description);
  info('Calling apps.manifest.create...');

  const createResult = await slackApi(
    'apps.manifest.create',
    {
      manifest: JSON.stringify(manifest),
    },
    configToken,
  );

  const appId = createResult.app_id;
  const credentials = createResult.credentials;
  ok(`App created! ID: ${appId}`);
  ok(`Client ID: ${credentials.client_id}`);
  ok(`Signing Secret: ${credentials.signing_secret.substring(0, 8)}...`);

  // ── Step 3: OAuth Install ─────────────────────────────────
  step(3, TOTAL_STEPS, 'Install App to Workspace (OAuth)');

  // Start callback server
  const oauthPromise = startOAuthCallbackServer(credentials.client_id, credentials.client_secret, OAUTH_REDIRECT_URI);

  // Build OAuth URL
  const oauthUrl = `https://slack.com/oauth/v2/authorize?client_id=${credentials.client_id}&scope=${BOT_SCOPES.join(',')}&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}`;

  console.log(`
  ${C.bold}Click this link to install the app:${C.reset}
  ${C.cyan}${oauthUrl}${C.reset}
`);

  // Try to open in browser
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${oauthUrl}"`, { stdio: 'ignore' });
      info('Opened in browser. Click "Allow" to install.');
    } else if (process.platform === 'linux') {
      execSync(`xdg-open "${oauthUrl}" 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch {
    /* ignore */
  }

  info('Waiting for OAuth callback...');
  const { botToken, teamId, botUserId } = await oauthPromise;
  ok(`Bot token captured: ${botToken.substring(0, 12)}...`);
  ok(`Team: ${teamId}, Bot User: ${botUserId}`);

  // ── Step 4: App-Level Token (manual) ──────────────────────
  step(4, TOTAL_STEPS, 'Create App-Level Token (Socket Mode)');

  const appSettingsUrl = `https://api.slack.com/apps/${appId}/general`;
  console.log(`
  ${C.yellow}⚠ This step requires manual action (Slack API limitation).${C.reset}

  1. Open: ${C.cyan}${appSettingsUrl}${C.reset}
  2. Scroll to ${C.bold}"App-Level Tokens"${C.reset}
  3. Click ${C.bold}"Generate Token and Scopes"${C.reset}
  4. Name: ${C.bold}"socket-mode"${C.reset}
  5. Add scope: ${C.bold}"connections:write"${C.reset}
  6. Click Generate → Copy the ${C.bold}xapp-...${C.reset} token
`);

  // Try to open
  try {
    if (process.platform === 'darwin') {
      execSync(`open "${appSettingsUrl}"`, { stdio: 'ignore' });
    }
  } catch {
    /* ignore */
  }

  const appToken = await ask(`  Paste App-Level Token (xapp-...): `);
  if (!appToken.startsWith('xapp-')) {
    err('App-Level Token must start with xapp-. Aborting.');
    console.log(`  You can add it manually to config.json later under agents.${agentName}.slackAppToken`);
    // Still save what we have
  }

  // ── Step 5: Update config.json + Create Prompt ────────────
  step(5, TOTAL_STEPS, 'Finalize Configuration');

  // Create prompt directory
  createPromptDir(agentName, description);

  // Update config.json
  if (!config.agents) config.agents = {};
  config.agents[agentName] = {
    slackBotToken: botToken,
    slackAppToken: appToken || 'PLACEHOLDER_ADD_XAPP_TOKEN',
    signingSecret: credentials.signing_secret,
    promptDir: `src/prompt/${agentName}`,
    description,
  };

  // Save
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  ok('config.json updated');

  // ── Done ──────────────────────────────────────────────────
  console.log(`
${C.bold}${C.green}═══════════════════════════════════════════════════${C.reset}
${C.bold}${C.green}  ✅ Agent '${agentName}' provisioned successfully!  ${C.reset}
${C.bold}${C.green}═══════════════════════════════════════════════════${C.reset}

  ${C.bold}App ID:${C.reset}         ${appId}
  ${C.bold}Bot Token:${C.reset}      ${botToken.substring(0, 12)}...
  ${C.bold}App Token:${C.reset}      ${appToken ? appToken.substring(0, 12) + '...' : 'NOT SET'}
  ${C.bold}Signing Secret:${C.reset} ${credentials.signing_secret.substring(0, 8)}...
  ${C.bold}Prompt Dir:${C.reset}     src/prompt/${agentName}/

  ${C.bold}Next steps:${C.reset}
  1. Edit prompt: ${C.cyan}src/prompt/${agentName}/default.prompt${C.reset}
  2. Restart soma-work: ${C.cyan}service.sh restart${C.reset}
  3. Test: ${C.cyan}@soma-${agentName} 안녕!${C.reset}
`);
}

main().catch((e) => {
  err(e.message || String(e));
  process.exit(1);
});
