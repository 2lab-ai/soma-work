import fs from 'fs';
import path from 'path';

const DEFAULT_DEV_SOURCE_DIR = '/opt/soma-work/dev';
const DEFAULT_LEGACY_ROOT_DIR = '/Users/dd/app.claude-code-slack-bot';
const MARKER_FILE_NAME = '.main-bootstrap.json';
const DEFAULT_MODEL = 'claude-opus-4-6';
const VALID_MODELS = new Set([
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-5-20251101',
  'claude-haiku-4-5-20251001',
]);

export interface BootstrapResult {
  bootstrapped: boolean;
  skipped: boolean;
  targetDir: string;
  markerFile: string;
}

export interface BootstrapOptions {
  targetDir: string;
  devSourceDir?: string;
  legacyRootDir?: string;
  normalize?: (targetDir: string) => Promise<void> | void;
  now?: () => Date;
}

function assertDirectoryExists(dirPath: string, label: string): void {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    throw new Error(`${label} directory not found: ${dirPath}`);
  }
}

function assertFileExists(filePath: string, label: string): void {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} file not found: ${filePath}`);
  }
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyFile(source: string, destination: string): void {
  ensureParentDir(destination);
  fs.copyFileSync(source, destination);
}

function copyDirectory(source: string, destination: string): void {
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function isNonEmptyDirectory(dirPath: string): boolean {
  if (!fs.existsSync(dirPath)) {
    return false;
  }

  const entries = fs.readdirSync(dirPath).filter(entry => entry !== '.DS_Store');
  return entries.length > 0;
}

function validateSeedFiles(devSourceDir: string): void {
  assertDirectoryExists(devSourceDir, 'dev source');
  assertFileExists(path.join(devSourceDir, '.system.prompt'), 'seed .system.prompt');
  assertFileExists(path.join(devSourceDir, 'config.json'), 'seed config.json');
  assertFileExists(path.join(devSourceDir, 'mcp-servers.json'), 'seed mcp-servers.json');
}

function assertTargetParentWritable(targetDir: string): void {
  if (fs.existsSync(targetDir)) {
    return;
  }

  const parentDir = path.dirname(targetDir);
  assertDirectoryExists(parentDir, 'target parent');

  try {
    fs.accessSync(parentDir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `Target parent directory is not writable: ${parentDir}. ` +
      `Pre-create ${targetDir} and chown it to the runner user.`
    );
  }
}

function writeMarker(markerFile: string, now: Date, devSourceDir: string, legacyRootDir: string): void {
  const payload = {
    completedAt: now.toISOString(),
    devSourceDir,
    legacyRootDir,
  };
  fs.writeFileSync(markerFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export async function normalizeMainTargetData(targetDir: string): Promise<void> {
  const dataDir = path.join(targetDir, 'data');
  const settingsFile = path.join(dataDir, 'user-settings.json');
  const sessionsFile = path.join(targetDir, 'data', 'sessions.json');

  if (fs.existsSync(settingsFile)) {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, Record<string, unknown>>;

    for (const userSettings of Object.values(settings)) {
      const model = typeof userSettings.defaultModel === 'string' ? userSettings.defaultModel : '';
      if (!model || !VALID_MODELS.has(model) || model === 'claude-opus-4-5-20251101') {
        userSettings.defaultModel = DEFAULT_MODEL;
      }
      if (userSettings.accepted === undefined) {
        userSettings.accepted = true;
      }
    }

    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  }

  if (fs.existsSync(sessionsFile)) {
    const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) as Array<Record<string, unknown>>;

    for (const session of sessions) {
      if (session.ownerId === undefined && typeof session.userId === 'string') {
        session.ownerId = session.userId;
      }
      if (session.state === undefined) {
        session.state = 'MAIN';
      }
      if (session.workflow === undefined) {
        session.workflow = 'default';
      }
    }

    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2) + '\n', 'utf8');
  }
}

export async function bootstrapMainEnvironment(options: BootstrapOptions): Promise<BootstrapResult> {
  const targetDir = options.targetDir;
  const devSourceDir = options.devSourceDir || DEFAULT_DEV_SOURCE_DIR;
  const legacyRootDir = options.legacyRootDir || DEFAULT_LEGACY_ROOT_DIR;
  const markerFile = path.join(targetDir, MARKER_FILE_NAME);
  const normalize = options.normalize || normalizeMainTargetData;
  const now = (options.now || (() => new Date()))();

  if (fs.existsSync(markerFile)) {
    return {
      bootstrapped: false,
      skipped: true,
      targetDir,
      markerFile,
    };
  }

  validateSeedFiles(devSourceDir);
  assertDirectoryExists(path.join(legacyRootDir, 'data'), 'legacy data');
  assertFileExists(path.join(legacyRootDir, '.env'), 'legacy .env');

  if (isNonEmptyDirectory(targetDir)) {
    throw new Error(`Refusing to bootstrap non-empty target without marker: ${targetDir}`);
  }

  assertTargetParentWritable(targetDir);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(targetDir, 'logs'), { recursive: true });

  copyFile(path.join(devSourceDir, '.system.prompt'), path.join(targetDir, '.system.prompt'));
  copyFile(path.join(devSourceDir, 'config.json'), path.join(targetDir, 'config.json'));
  copyFile(path.join(devSourceDir, 'mcp-servers.json'), path.join(targetDir, 'mcp-servers.json'));

  const devPluginsDir = path.join(devSourceDir, 'plugins');
  if (fs.existsSync(devPluginsDir) && fs.statSync(devPluginsDir).isDirectory()) {
    copyDirectory(devPluginsDir, path.join(targetDir, 'plugins'));
  }

  copyFile(path.join(legacyRootDir, '.env'), path.join(targetDir, '.env'));
  copyDirectory(path.join(legacyRootDir, 'data'), path.join(targetDir, 'data'));

  await normalize(targetDir);
  writeMarker(markerFile, now, devSourceDir, legacyRootDir);

  return {
    bootstrapped: true,
    skipped: false,
    targetDir,
    markerFile,
  };
}

async function main(): Promise<void> {
  const targetDir = process.env.TARGET || '/opt/soma-work/main';
  const devSourceDir = process.env.DEV_SOURCE || DEFAULT_DEV_SOURCE_DIR;
  const legacyRootDir = process.env.LEGACY_ROOT || DEFAULT_LEGACY_ROOT_DIR;

  const result = await bootstrapMainEnvironment({
    targetDir,
    devSourceDir,
    legacyRootDir,
  });

  if (result.skipped) {
    console.log(`bootstrap: skipped (${result.markerFile})`);
    return;
  }

  console.log(`bootstrap: complete (${result.targetDir})`);
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`bootstrap: failed (${message})`);
    process.exit(1);
  });
}
