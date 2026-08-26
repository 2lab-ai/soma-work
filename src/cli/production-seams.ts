/**
 * Production wiring for the controller CLI.
 *
 * Every seam the orchestrator, the doctor and the service manager declare has a
 * real implementation, and this is where they are built. It exists as its own
 * module for two reasons:
 *
 * - **`index.ts` can import it lazily.** The private Slack hook routes must not
 *   pay for — or be polluted by — the runtime's module graph, and `doctor --json`
 *   needs the noisy imports to happen *inside* its capture boundary. A static
 *   import in the router would defeat both.
 * - **The seams stay honest.** Nothing here decides policy. Where a value could
 *   be guessed (a runtime root, a workspace mode, a base directory) the rule
 *   lives in the module that owns it and this file supplies only the syscall.
 *
 * ## Packaged asset paths
 *
 * The four runtime-root-relative paths below are the layout Task 11 stages and
 * smoke-tests. They are constants rather than searches: a wizard that goes
 * looking for "a config that looks canonical" is a wizard that materializes a
 * profile from whatever it found.
 */

import { ensureDirectory } from '@soma/common/atomic-write';
import { getSomaHome } from '@soma/common/soma-paths';
import dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { createDefaultDoctorDeps, type DoctorReport, type DoctorRuntimeAsset, runDoctor } from './doctor';
import { type ProfileName, type ProfilePaths, profilePaths, type RuntimeInstall } from './profile';
import {
  createNodeProcessProbe,
  createNodeServiceFileSystem,
  resolveServiceNodePath,
  ServiceError,
  ServiceManager,
  serviceArtifacts,
} from './service';
import type { PackagedAsset, ProfileReceipt } from './setup/materialize';
import { RUNTIME_ENV_FILENAME } from './setup/materialize';
import {
  DEFAULT_WORKSPACES_DIRNAME,
  discoverRuntimes,
  REQUIRED_RUNTIME_ENTRIES,
  type RuntimeDiscoveryFileSystem,
  type SetupChoice,
  type SetupDoctorInput,
  type SetupOutput,
  type SetupPrompt,
  type SetupServiceInput,
  type SetupServiceManager,
  type SetupWorkspaceFs,
  WORKSPACE_DIR_MODE,
} from './setup/orchestrator';
import { RealHost } from './setup/real-host';
import { SecretStore } from './setup/secrets';
import { CANONICAL_MANIFEST_RELATIVE_PATH } from './setup/slack-manifest';

// ---------------------------------------------------------------------------
// Packaged runtime layout
// ---------------------------------------------------------------------------

/** Canonical materializer input, at the runtime root. */
export const PACKAGED_CONFIG_ASSET = 'config.default.json';
/** Canonical non-empty default prompt, at the runtime root. */
export const PACKAGED_PROMPT_ASSET = '.system.prompt.example';
/** The executable controller entry the formula links. */
export const PACKAGED_CONTROLLER_ENTRY = 'dist/cli/index.js';

/**
 * What `somawork doctor`'s runtime check requires of an install.
 *
 * The two service entries plus the controller are what a running profile
 * actually execs; the three assets are what `setup` re-reads on every run, so a
 * runtime missing them can be diagnosed rather than discovered halfway through
 * a re-materialization.
 */
export const RUNTIME_ASSETS: readonly DoctorRuntimeAsset[] = [
  ...REQUIRED_RUNTIME_ENTRIES.map((entry) => ({ path: entry, required: true })),
  { path: PACKAGED_CONTROLLER_ENTRY, required: true },
  { path: PACKAGED_CONFIG_ASSET, required: true },
  { path: PACKAGED_PROMPT_ASSET, required: true },
  { path: CANONICAL_MANIFEST_RELATIVE_PATH, required: true },
];

/** The two packaged assets `materializeProfile` copies into a profile. */
export function packagedAssets(runtimeRoot: string): { defaultConfig: PackagedAsset; systemPrompt: PackagedAsset } {
  return {
    defaultConfig: { path: path.join(runtimeRoot, PACKAGED_CONFIG_ASSET) },
    systemPrompt: { path: path.join(runtimeRoot, PACKAGED_PROMPT_ASSET) },
  };
}

// ---------------------------------------------------------------------------
// Process facts
// ---------------------------------------------------------------------------

/** Current uid, or `0` where the platform has no such concept. */
export function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

// ---------------------------------------------------------------------------
// Filesystem seams
// ---------------------------------------------------------------------------

export function createRuntimeDiscoveryFs(): RuntimeDiscoveryFileSystem {
  return {
    realpath(target) {
      try {
        return fs.realpathSync(target);
      } catch {
        return null;
      }
    },
    isDirectory(target) {
      try {
        return fs.statSync(target).isDirectory();
      } catch {
        return false;
      }
    },
    isFile(target) {
      try {
        return fs.statSync(target).isFile();
      } catch {
        return false;
      }
    },
    readFile(target) {
      try {
        return fs.readFileSync(target, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Workspace-root filesystem.
 *
 * `createDir` is the ONLY mutation, and it is reached only for the default path
 * when nothing is there. `ensureDirectory` supplies the umask-correct create
 * plus the symlinked-ancestor refusal; because the caller has already proved
 * the target is absent, its "tighten an existing directory" behaviour cannot
 * apply to a directory the operator owns.
 */
export function createWorkspaceFs(): SetupWorkspaceFs {
  return {
    exists(target) {
      try {
        fs.lstatSync(target);
        return true;
      } catch {
        return false;
      }
    },
    lstat(target) {
      try {
        const stat = fs.lstatSync(target);
        return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), isSymbolicLink: stat.isSymbolicLink() };
      } catch {
        return null;
      }
    },
    canWrite(target) {
      try {
        fs.accessSync(target, fs.constants.W_OK | fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    createDir(target, mode) {
      ensureDirectory(target, mode);
    },
  };
}

/**
 * The `BASE_DIRECTORY` an already-materialized profile declares, or `null`.
 *
 * This is what keeps a re-run from silently relocating an operator's workspace
 * root to the default. Parsed with `dotenv` over the profile's own `.env`, which
 * this tool wrote; no value from it is ever executed or interpolated.
 */
export function readExistingBaseDirectory(configDir: string): string | null {
  try {
    const parsed = dotenv.parse(fs.readFileSync(path.join(configDir, RUNTIME_ENV_FILENAME), 'utf-8'));
    const declared = parsed.BASE_DIRECTORY;
    return typeof declared === 'string' && declared.trim().length > 0 ? declared : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Terminal seams
// ---------------------------------------------------------------------------

/**
 * The one non-secret question surface.
 *
 * Reads from stdin and writes the menu to **stderr**, so `somawork setup` piped
 * into a file still shows its questions on the terminal and still leaves stdout
 * free of prompt text. A non-TTY stdin, EOF, or an out-of-range answer is a
 * refusal rather than a silent default: guessing which profile or which
 * workspace an operator meant is exactly the mistake worth failing on.
 */
export function createTerminalPrompt(): SetupPrompt {
  return {
    choose(question: string, choices: readonly SetupChoice[]): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (choices.length === 0) {
          reject(new Error('No choices were offered.'));
          return;
        }

        const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
        let answered = false;

        process.stderr.write(`\n${question}\n`);
        for (const [index, choice] of choices.entries()) {
          process.stderr.write(`  ${index + 1}) ${choice.label}\n`);
        }

        // Closed without an answer — a piped/EOF stdin, or Ctrl-D. Refusing is
        // the point: defaulting a profile or a workspace choice picks which
        // Slack workspace someone's bot lands in.
        rl.once('close', () => {
          if (!answered) reject(new Error('No choice was made.'));
        });

        rl.question(`Enter 1-${choices.length}: `, (answer) => {
          answered = true;
          rl.close();
          const index = Number.parseInt(answer.trim(), 10);
          if (!Number.isInteger(index) || index < 1 || index > choices.length) {
            reject(new Error('That is not one of the offered choices.'));
            return;
          }
          resolve(choices[index - 1].value);
        });
      });
    },
  };
}

/** Terminal renderer. Progress on stderr, the completion card on stdout. */
export function createTerminalOutput(): SetupOutput {
  let index = 0;
  return {
    step(_step, message) {
      index += 1;
      process.stderr.write(`\n[${index}/8] ${message}\n`);
    },
    info(message) {
      const text = String(message).trimEnd();
      if (text.length > 0) process.stderr.write(`      ${text}\n`);
    },
    instruction(text) {
      // The one place the ticket line is allowed to appear. Ephemeral display:
      // never logged, never persisted, never included in a report.
      process.stderr.write(`\n${text}\n\n`);
    },
    card(lines) {
      process.stdout.write(`\n${lines.join('\n')}\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Doctor
// ---------------------------------------------------------------------------

/** Build the doctor's dependency set for one profile and run it. */
export async function runProfileDoctor(input: SetupDoctorInput): Promise<DoctorReport> {
  return runDoctor(
    input.profile,
    createDefaultDoctorDeps({
      paths: input.paths,
      runtime: input.runtime,
      baseDirectory: input.baseDirectory,
      uid: currentUid(),
      runtimeAssets: RUNTIME_ASSETS,
      readSecrets: () => new SecretStore({ secretsFile: input.paths.secretsFile }).read(),
    }),
  );
}

/**
 * `somawork doctor` / `somawork status` for a profile that already exists.
 *
 * The runtime is discovered rather than assumed, and the base directory comes
 * from the profile's own `.env` — falling back to the product default only when
 * the profile has never been materialized, in which case the doctor's own
 * base-directory check is what reports it.
 */
export async function runDoctorForProfile(input: {
  profile: ProfileName;
  home: string;
  uid: number;
}): Promise<DoctorReport> {
  const paths = profilePaths(input.home, input.profile);
  const runtimes = await discoverRuntimes({ host: new RealHost(), fs: createRuntimeDiscoveryFs() });
  const runtime: RuntimeInstall = runtimes.find((candidate) => candidate.profile === input.profile) ?? {
    profile: input.profile,
    root: '',
    version: 'not-installed',
  };
  const baseDirectory =
    readExistingBaseDirectory(paths.configDir) ?? path.join(paths.dataDir, DEFAULT_WORKSPACES_DIRNAME);

  return runDoctor(
    input.profile,
    createDefaultDoctorDeps({
      paths,
      runtime,
      baseDirectory,
      uid: input.uid,
      runtimeAssets: RUNTIME_ASSETS,
      readSecrets: () => new SecretStore({ secretsFile: paths.secretsFile }).read(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Build Task 9's `ServiceManager` for the profile the orchestrator just
 * materialized, with **every other installed profile wired in as a peer**.
 *
 * The empty `peers` default in `ServiceManagerDeps` is test convenience; an
 * orchestration that leaves it empty simply never runs the collision gate.
 */
export async function createServiceManager(
  input: SetupServiceInput & { home: string; uid: number },
): Promise<SetupServiceManager> {
  const host = new RealHost();
  const serviceFs = createNodeServiceFileSystem();
  const nodePath = await resolveServiceNodePath({ host, fs: serviceFs });

  const artifacts = serviceArtifacts({
    home: input.home,
    uid: input.uid,
    receipt: input.receipt,
    paths: input.paths,
    nodePath,
  });
  const peers = input.peers.map((receipt) =>
    serviceArtifacts({
      home: input.home,
      uid: input.uid,
      receipt,
      paths: profilePaths(input.home, receipt.profile),
      nodePath,
    }),
  );

  return new ServiceManager({
    artifacts,
    host,
    fs: serviceFs,
    processes: createNodeProcessProbe(),
    peers,
    runDoctor: () =>
      runProfileDoctor({
        profile: input.receipt.profile,
        paths: input.paths,
        runtime: input.runtime,
        baseDirectory: input.receipt.baseDirectory,
        receipt: input.receipt,
      }),
  });
}

/**
 * Build a `ServiceManager` for `somawork service …` on an existing profile.
 *
 * The receipt is reconstructed from the profile's fixed paths plus the
 * discovered runtime — the same derivation `serviceArtifacts` performs, so a
 * `service start` and the `setup` that installed it agree byte for byte.
 */
export async function createProfileServiceManager(input: {
  profile: ProfileName;
  home: string;
  uid: number;
}): Promise<ServiceManager> {
  const runtimes = await discoverRuntimes({ host: new RealHost(), fs: createRuntimeDiscoveryFs() });
  const runtime = runtimes.find((candidate) => candidate.profile === input.profile);
  if (runtime === undefined) {
    throw new ServiceError(
      `The "${input.profile}" runtime is not installed; install it and run "somawork setup" before managing its service.`,
      'not-installed',
    );
  }

  const paths = profilePaths(input.home, input.profile);
  const receipt = receiptForProfile(input.profile, paths, runtime);
  const peers = runtimes
    .filter((candidate) => candidate.profile !== input.profile)
    .map((candidate) => {
      const peerPaths = profilePaths(input.home, candidate.profile);
      return receiptForProfile(candidate.profile, peerPaths, candidate);
    });

  const managed = await createServiceManager({
    receipt,
    runtime,
    paths,
    peers,
    home: input.home,
    uid: input.uid,
  });
  return managed as ServiceManager;
}

function receiptForProfile(profile: ProfileName, paths: ProfilePaths, runtime: RuntimeInstall): ProfileReceipt {
  const runtimeEnvFile = path.join(paths.configDir, RUNTIME_ENV_FILENAME);
  return {
    profile,
    runtimeVersion: runtime.version,
    runtimeRoot: runtime.root,
    configDir: paths.configDir,
    runtimeEnvFile,
    configFile: path.join(paths.configDir, 'config.json'),
    promptFile: path.join(paths.configDir, '.system.prompt'),
    runtimeDataDir: path.join(paths.configDir, 'data'),
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    baseDirectory: readExistingBaseDirectory(paths.configDir) ?? path.join(paths.dataDir, DEFAULT_WORKSPACES_DIRNAME),
    appId: '',
    teamId: '',
    serviceEnvFiles: [runtimeEnvFile, paths.secretsFile],
  };
}

/**
 * Home directory for profile-scoped state.
 *
 * Delegates to `@soma/common/soma-paths`, which owns the
 * `SOMAWORK_HOME` → `SOMA_HOME` → OS-home precedence. Re-implementing the
 * lookup here is what let the canonical name go unread for a release.
 */
export function resolveControllerHome(env: NodeJS.ProcessEnv = process.env): string {
  return getSomaHome(env);
}

export { WORKSPACE_DIR_MODE };
