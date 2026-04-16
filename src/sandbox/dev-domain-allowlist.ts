/**
 * Preset "Tier 2" developer-domain allowlist for the Claude Agent SDK sandbox
 * network policy (`sandbox.network.allowedDomains`).
 *
 * Goal: let ~95% of day-to-day development work (clone / install / test /
 * deploy / talk-to-LLMs) succeed without the model being blocked at the
 * network layer, while keeping the deny-by-default posture for everything
 * else.
 *
 * Sources consulted:
 *  - anthropics/claude-code/.devcontainer/init-firewall.sh
 *    https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh
 *  - GitHub Copilot allowlist reference (broadest vendor-published list)
 *    https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
 *  - centminmod/claude-code-devcontainers init-firewall.sh (community-maintained)
 *    https://github.com/centminmod/claude-code-devcontainers/blob/master/.devcontainer/init-firewall.sh
 *  - Claude Code enterprise network-config docs
 *    https://code.claude.com/docs/en/network-config
 *
 * Wildcards use the Claude Agent SDK's `allowedDomains` syntax: `*.example.com`
 * matches any subdomain. Each entry is lower-case and contains no scheme or
 * trailing dot. Do NOT add comments / empty strings — the `.test.ts`
 * counterpart enforces format and uniqueness invariants.
 */

/** Anthropic / Claude Code first-party endpoints. */
export const ALLOWLIST_ANTHROPIC = [
  'api.anthropic.com',
  '*.anthropic.com',
  'claude.ai',
  'platform.claude.com',
  'downloads.claude.ai',
  'bridge.claudeusercontent.com',
  'statsig.anthropic.com',
  'statsig.com',
  'sentry.io',
] as const;

/** Git hosting services (source control + raw file fetch). */
export const ALLOWLIST_GIT_HOSTING = [
  'github.com',
  '*.github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  '*.githubusercontent.com',
  'codeload.github.com',
  'lfs.github.com',
  'gitlab.com',
  '*.gitlab.com',
  'bitbucket.org',
  '*.bitbucket.org',
] as const;

/** GitHub Actions runner + container registries (pull-only). */
export const ALLOWLIST_REGISTRIES = [
  '*.actions.githubusercontent.com',
  '*.pkg.github.com',
  'ghcr.io',
  '*.docker.io',
  '*.docker.com',
  'quay.io',
  'mcr.microsoft.com',
  'gcr.io',
  '*.gcr.io',
  'public.ecr.aws',
] as const;

/** Node / JavaScript / TypeScript ecosystem. */
export const ALLOWLIST_NODE = [
  'registry.npmjs.org',
  'registry.npmjs.com',
  'npmjs.com',
  'npmjs.org',
  'yarnpkg.com',
  'registry.yarnpkg.com',
  'get.pnpm.io',
  'nodejs.org',
  'deno.land',
  'esm.sh',
  'unpkg.com',
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
] as const;

/** Python ecosystem (pip, conda, pytorch, uv/ruff). */
export const ALLOWLIST_PYTHON = [
  'pypi.org',
  'pypi.python.org',
  '*.pythonhosted.org',
  'files.pythonhosted.org',
  'anaconda.org',
  'conda.anaconda.org',
  'repo.anaconda.com',
  'download.pytorch.org',
  'astral.sh',
] as const;

/** Rust, Go, Java/Kotlin, Ruby, PHP, .NET, Dart, Swift, Haskell, Perl. */
export const ALLOWLIST_OTHER_LANGS = [
  // Rust
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'static.rust-lang.org',
  'sh.rustup.rs',
  // Go
  'go.dev',
  'golang.org',
  'proxy.golang.org',
  'sum.golang.org',
  'pkg.go.dev',
  // Java / Kotlin / Scala
  'repo.maven.apache.org',
  'repo1.maven.org',
  'search.maven.org',
  'maven.pkg.github.com',
  'maven.google.com',
  'services.gradle.org',
  'plugins.gradle.org',
  'oss.sonatype.org',
  'adoptium.net',
  'api.adoptium.net',
  // Ruby
  'rubygems.org',
  'api.rubygems.org',
  // PHP
  'packagist.org',
  'repo.packagist.org',
  'getcomposer.org',
  // .NET / NuGet
  'nuget.org',
  'api.nuget.org',
  'nuget.pkg.github.com',
  // Dart / Flutter
  'pub.dev',
  // Swift / iOS
  'swift.org',
  'cocoapods.org',
  'cdn.cocoapods.org',
  // Haskell / Perl
  '*.hackage.haskell.org',
  'metacpan.org',
  'cpan.org',
] as const;

/** Linux distro package repositories (apt / yum / apk / dnf). */
export const ALLOWLIST_LINUX_DISTROS = [
  'archive.ubuntu.com',
  'security.ubuntu.com',
  'deb.debian.org',
  'security.debian.org',
  'dl.fedoraproject.org',
  'dl-cdn.alpinelinux.org',
  'packages.microsoft.com',
  'packages.cloud.google.com',
] as const;

/** Major cloud providers (AWS, GCP, Azure, Cloudflare). */
export const ALLOWLIST_CLOUD = [
  '*.amazonaws.com',
  '*.aws.amazon.com',
  '*.googleapis.com',
  'storage.googleapis.com',
  'oauth2.googleapis.com',
  '*.azure.com',
  '*.windows.net',
  'pkgs.dev.azure.com',
  'api.cloudflare.com',
  '*.cloudflare.com',
] as const;

/** Third-party LLM / AI APIs that developers commonly call. */
export const ALLOWLIST_AI_APIS = [
  'api.openai.com',
  'auth.openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
  'aistudio.google.com',
  'huggingface.co',
  'api-inference.huggingface.co',
  'hf.co',
  '*.hf.co',
  'openrouter.ai',
  'api.cohere.ai',
  'api.together.xyz',
  'api.replicate.com',
  'api.mistral.ai',
  'api.groq.com',
  'api.deepseek.com',
  'api.perplexity.ai',
  '*.2lab.ai',
] as const;

/** Editor / IDE support surfaces. */
export const ALLOWLIST_IDE = [
  'marketplace.visualstudio.com',
  'vscode.blob.core.windows.net',
  'update.code.visualstudio.com',
  '*.visualstudio.com',
] as const;

/**
 * Flat, deduplicated allowlist. Exported as `readonly string[]` so callers can
 * pass a fresh spread into `sandbox.network.allowedDomains` without mutating
 * the constant.
 *
 * Stability note: this list is intentionally evergreen — adding a domain is
 * safe, removing one can block users. Before removing, check if it's still
 * referenced by any active dev workflow.
 */
export const DEV_DOMAIN_ALLOWLIST: readonly string[] = Array.from(
  new Set([
    ...ALLOWLIST_ANTHROPIC,
    ...ALLOWLIST_GIT_HOSTING,
    ...ALLOWLIST_REGISTRIES,
    ...ALLOWLIST_NODE,
    ...ALLOWLIST_PYTHON,
    ...ALLOWLIST_OTHER_LANGS,
    ...ALLOWLIST_LINUX_DISTROS,
    ...ALLOWLIST_CLOUD,
    ...ALLOWLIST_AI_APIS,
    ...ALLOWLIST_IDE,
  ]),
);
