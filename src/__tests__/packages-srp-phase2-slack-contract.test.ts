import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..');

interface PackageManifest {
  name?: string;
  exports?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')) as T;
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        out.push(fullPath);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('packages-srp Phase 2 slack contract', () => {
  it('@soma/slack owns Slack leaf UI helpers with legacy src shims', () => {
    const manifestPath = path.join(repoRoot, 'packages/slack/package.json');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = readJson<PackageManifest>('packages/slack/package.json');
    expect(manifest.name).toBe('@soma/slack');
    expect(manifest.files).toEqual(expect.arrayContaining(['dist']));
    expect(manifest.exports).toMatchObject({
      '.': './dist/index.js',
      './action-panel-builder': './dist/action-panel-builder.js',
      './actions': './dist/actions/index.js',
      './actions/click-classifier': './dist/actions/click-classifier.js',
      './actions/pending-form-store': './dist/actions/pending-form-store.js',
      './actions/pending-instruction-confirm-store': './dist/actions/pending-instruction-confirm-store.js',
      './actions/user-skill-action-kinds': './dist/actions/user-skill-action-kinds.js',
      './assistant-container': './dist/assistant-container.js',
      './assistant-status-manager': './dist/assistant-status-manager.js',
      './channel-description-cache': './dist/channel-description-cache.js',
      './channel-registry': './dist/channel-registry.js',
      './choice-message-builder': './dist/choice-message-builder.js',
      './command-parser': './dist/command-parser.js',
      './commands/command-router': './dist/commands/command-router.js',
      './completion-message-tracker': './dist/completion-message-tracker.js',
      './create-fork-executor': './dist/create-fork-executor.js',
      './cct/action-value': './dist/cct/action-value.js',
      './cct/render-in-place': './dist/cct/render-in-place.js',
      './cct/views': './dist/cct/views.js',
      './context-window-manager': './dist/context-window-manager.js',
      './directives': './dist/directives/index.js',
      './directives/channel-message-directive': './dist/directives/channel-message-directive.js',
      './directives/session-link-directive': './dist/directives/session-link-directive.js',
      './directives/source-working-dir-directive': './dist/directives/source-working-dir-directive.js',
      './dispatch-abort': './dist/dispatch-abort.js',
      './event-router': './dist/event-router.js',
      './formatters': './dist/formatters/index.js',
      './formatters/markdown-to-blocks': './dist/formatters/markdown-to-blocks.js',
      './formatters/directory-formatter': './dist/formatters/directory-formatter.js',
      './handoff-budget': './dist/handoff-budget.js',
      './instruction-confirm-blocks': './dist/instruction-confirm-blocks.js',
      './message-formatter': './dist/message-formatter.js',
      './message-validator': './dist/message-validator.js',
      './mcp-health-monitor': './dist/mcp-health-monitor.js',
      './mcp-status-tracker': './dist/mcp-status-tracker.js',
      './mrkdwn-escape': './dist/mrkdwn-escape.js',
      './output-flags': './dist/output-flags.js',
      './pipeline': './dist/pipeline/index.js',
      './pipeline/input-processor': './dist/pipeline/input-processor.js',
      './pipeline/session-initializer': './dist/pipeline/session-initializer.js',
      './pipeline/stream-executor': './dist/pipeline/stream-executor.js',
      './pipeline/local-slash-command': './dist/pipeline/local-slash-command.js',
      './pipeline/effective-phase': './dist/pipeline/effective-phase.js',
      './pipeline/stream-stall-watchdog': './dist/pipeline/stream-stall-watchdog.js',
      './pipeline/types': './dist/pipeline/types.js',
      './reaction-manager': './dist/reaction-manager.js',
      './release-notifier': './dist/release-notifier.js',
      './request-coordinator': './dist/request-coordinator.js',
      './session-manager': './dist/session-manager.js',
      './slash-command-adapter': './dist/slash-command-adapter.js',
      './slack-api-helper': './dist/slack-api-helper.js',
      './source-thread-summary': './dist/source-thread-summary.js',
      './startup-notifier': './dist/startup-notifier.js',
      './status-reporter': './dist/status-reporter.js',
      './stream-processor': './dist/stream-processor.js',
      './summary-service': './dist/summary-service.js',
      './summary-timer': './dist/summary-timer.js',
      './task-list-block-builder': './dist/task-list-block-builder.js',
      './thread-panel': './dist/thread-panel.js',
      './thread-header-builder': './dist/thread-header-builder.js',
      './thread-surface': './dist/thread-surface.js',
      './todo-display-manager': './dist/todo-display-manager.js',
      './tool-event-processor': './dist/tool-event-processor.js',
      './tool-formatter': './dist/tool-formatter.js',
      './tool-tracker': './dist/tool-tracker.js',
      './turn-notifier': './dist/turn-notifier.js',
      './turn-render-debouncer': './dist/turn-render-debouncer.js',
      './turn-surface': './dist/turn-surface.js',
      './user-choice-handler': './dist/user-choice-handler.js',
      './user-choice-extractor': './dist/user-choice-extractor.js',
      './user-skill-file-roundtrip': './dist/user-skill-file-roundtrip.js',
      './z/capability': './dist/z/capability.js',
      './z/normalize': './dist/z/normalize.js',
      './z/respond': './dist/z/respond.js',
      './z/router': './dist/z/router.js',
      './z/strip-z-prefix': './dist/z/strip-z-prefix.js',
      './z/tombstone': './dist/z/tombstone.js',
      './z/types': './dist/z/types.js',
      './z/ui-builder': './dist/z/ui-builder.js',
      './z/whitelist': './dist/z/whitelist.js',
    });
    expect(manifest.scripts).toMatchObject({ build: 'tsc -p tsconfig.json' });
    expect(manifest.dependencies).toMatchObject({
      '@soma/common': '*',
      '@slack/bolt': '=4.7.0',
      '@slack/web-api': '^7.15.1',
      'markdown-to-slack-blocks': '^1.4.1',
    });

    const movedModules = [
      'action-panel-builder',
      'actions/click-classifier',
      'actions/pending-form-store',
      'actions/pending-instruction-confirm-store',
      'actions/user-skill-action-kinds',
      'assistant-container',
      'assistant-status-manager',
      'channel-description-cache',
      'channel-registry',
      'choice-message-builder',
      'command-parser',
      'commands/command-router',
      'completion-message-tracker',
      'create-fork-executor',
      'cct/action-value',
      'cct/render-in-place',
      'cct/views',
      'context-window-manager',
      'directives/channel-message-directive',
      'directives/session-link-directive',
      'directives/source-working-dir-directive',
      'dispatch-abort',
      'event-router',
      'formatters/markdown-to-blocks',
      'formatters/directory-formatter',
      'handoff-budget',
      'instruction-confirm-blocks',
      'message-formatter',
      'message-validator',
      'mcp-health-monitor',
      'mcp-status-tracker',
      'mrkdwn-escape',
      'output-flags',
      'pipeline/input-processor',
      'pipeline/session-initializer',
      'pipeline/stream-executor',
      'pipeline/local-slash-command',
      'pipeline/effective-phase',
      'pipeline/stream-stall-watchdog',
      'pipeline/types',
      'reaction-manager',
      'release-notifier',
      'request-coordinator',
      'session-manager',
      'slash-command-adapter',
      'slack-api-helper',
      'source-thread-summary',
      'startup-notifier',
      'status-reporter',
      'stream-processor',
      'summary-service',
      'summary-timer',
      'task-list-block-builder',
      'thread-panel',
      'thread-header-builder',
      'thread-surface',
      'todo-display-manager',
      'tool-event-processor',
      'tool-formatter',
      'tool-tracker',
      'turn-notifier',
      'turn-render-debouncer',
      'turn-surface',
      'user-choice-handler',
      'user-choice-extractor',
      'user-skill-file-roundtrip',
      'z/capability',
      'z/normalize',
      'z/respond',
      'z/router',
      'z/strip-z-prefix',
      'z/tombstone',
      'z/types',
      'z/ui-builder',
      'z/whitelist',
    ];
    for (const moduleName of movedModules) {
      const packageSource = path.join(repoRoot, 'packages/slack/src', `${moduleName}.ts`);
      const legacySource = path.join(
        repoRoot,
        [
          'channel-description-cache',
          'channel-registry',
          'release-notifier',
          'startup-notifier',
          'turn-notifier',
        ].includes(moduleName)
          ? 'src'
          : 'src/slack',
        `${moduleName}.ts`,
      );

      expect(fs.existsSync(packageSource), packageSource).toBe(true);
      expect(fs.existsSync(legacySource), legacySource).toBe(true);

      const legacyText = fs.readFileSync(legacySource, 'utf8');
      expect(legacyText, legacySource).toContain(`@soma/slack/${moduleName}`);
      expect(legacyText, legacySource).toMatch(/\bexport\s/);
      expect(legacyText, legacySource).not.toMatch(
        /function escapeSlackMrkdwn|const VERBOSITY_MAP|const TOMBSTONE_HINTS|SLASH_BUTTON_VALUE_MAX|class ActionHandlers|class ActionPanelBuilder|class AssistantStatusManager|class ChannelEphemeralZRespond|class ChoiceMessageBuilder|class CommandParser|class CommandRouter|class DirectoryFormatter|class DispatchAbortError|class DmZRespond|class EventRouter|class HandoffBudgetExhaustedError|class InputProcessor|class MessageFormatter|class MessageValidator|class McpHealthMonitor|class McpStatusDisplay|class SessionInitializer|class SessionUiManager|class SlashCommandAdapter|class SlashZRespond|class StreamExecutor|class StreamProcessor|class SummaryService|class SummaryTimer|class CompletionMessageTracker|class ThreadHeaderBuilder|class ThreadPanel|class ThreadSurface|class TodoDisplayManager|class ToolEventProcessor|class ToolFormatter|class TurnNotifier|class TurnRenderDebouncer|class TurnSurface|class ZRouter|class ChannelMessageDirectiveHandler|class SessionLinkDirectiveHandler|class SourceWorkingDirDirectiveHandler|class ContextWindowManager|class ReactionManager|class RequestCoordinator|class SlackApiHelper|class StatusReporter|class TaskListBlockBuilder|class ToolTracker|class UserChoiceExtractor|class UserChoiceHandler|function buildAssistantConfig|function buildInstructionConfirmBlocks|function buildMarkerBlocks|function buildRequestCompleteBlocks|function buildRequestStartBlocks|function checkAndConsumeBudget|function checkRepoChannelMatch|function classifyClick|function consumePendingSkillUpload|function createAssistantContainer|function createForkExecutor|function determineTurnCategory|function extractTaskIdFromResult|function formatDispatchAbortMessage|function getChannelDescription|function getEffectiveFiveBlockPhase|function markdownToBlocks|function normalizeUtilizationToPercent|function notifyRelease|function notifyStartup|function parseTopic|function registerChannel|function renderInPlace|function scanChannels|function setSlackWorkspaceUrl|function shouldRunLegacyB4Path|function translateToLegacy|function uploadSkillFile/,
      );
    }

    const movedIndexModules = ['actions', 'directives', 'formatters', 'pipeline'];
    for (const moduleName of movedIndexModules) {
      const packageSource = path.join(repoRoot, 'packages/slack/src', moduleName, 'index.ts');
      const legacySource = path.join(repoRoot, 'src/slack', moduleName, 'index.ts');

      expect(fs.existsSync(packageSource), packageSource).toBe(true);
      expect(fs.existsSync(legacySource), legacySource).toBe(true);

      const legacyText = fs.readFileSync(legacySource, 'utf8');
      expect(legacyText, legacySource).toContain(`@soma/slack/${moduleName}`);
      expect(legacyText, legacySource).toMatch(/\bexport\s/);
      expect(legacyText, legacySource).not.toMatch(/class ActionHandlers|class DirectoryFormatter|class InputProcessor/);
    }

    const sourceFiles = listFiles(path.join(repoRoot, 'packages/slack/src')).filter((file) => file.endsWith('.ts'));
    for (const file of sourceFiles) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/from ['"](\.\.\/\.\.\/src\/|src\/|somalib\/)/);
    }
  });
});
