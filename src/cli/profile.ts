import path from 'path';

/**
 * Runtime profile identifiers. `preview` and `production` run side-by-side with
 * fully isolated config/secrets/data/state directories and service labels.
 */
export type ProfileName = 'preview' | 'production';

const PROFILE_NAMES: readonly ProfileName[] = ['preview', 'production'];

/**
 * A runtime install discovered on disk (or reported by the profile materializer).
 */
export interface RuntimeInstall {
  profile: ProfileName;
  root: string;
  version: string;
}

/**
 * Fully-resolved, profile-scoped filesystem/service paths.
 */
export interface ProfilePaths {
  configDir: string;
  secretsFile: string;
  dataDir: string;
  stateDir: string;
  serviceLabel: string;
}

export function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

export class ProfileResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileResolutionError';
  }
}

/**
 * Resolve which profile a command should operate on.
 *
 * - If `requested` is given, it must be a valid `ProfileName`.
 * - Otherwise, infer from installed runtimes: exactly one distinct installed
 *   profile is unambiguous; zero or two-plus are errors.
 */
export function resolveProfile(input: { requested?: string; installed: RuntimeInstall[] }): ProfileName {
  const { requested, installed } = input;

  if (requested !== undefined) {
    if (!isProfileName(requested)) {
      throw new ProfileResolutionError(`Invalid profile "${requested}". Expected one of: ${PROFILE_NAMES.join(', ')}.`);
    }
    return requested;
  }

  const distinctProfiles = Array.from(new Set(installed.map((i) => i.profile)));

  if (distinctProfiles.length === 0) {
    throw new ProfileResolutionError(
      'No somawork runtime is installed. Run "somawork setup --profile <preview|production>" first, or pass --profile explicitly.',
    );
  }

  if (distinctProfiles.length > 1) {
    throw new ProfileResolutionError(
      `Multiple profiles are installed (${distinctProfiles.join(', ')}). Pass --profile to disambiguate.`,
    );
  }

  return distinctProfiles[0];
}

/**
 * Compute the isolated filesystem/service paths for a profile under `home`.
 */
export function profilePaths(home: string, profile: ProfileName): ProfilePaths {
  const configDir = path.join(home, '.config', 'somawork', 'profiles', profile);
  const dataDir = path.join(home, '.local', 'share', 'somawork', profile);
  const stateDir = path.join(home, '.local', 'state', 'somawork', profile);

  return {
    configDir,
    secretsFile: path.join(configDir, 'secrets.env'),
    dataDir,
    stateDir,
    serviceLabel: `ai.2lab.somawork.${profile}`,
  };
}
