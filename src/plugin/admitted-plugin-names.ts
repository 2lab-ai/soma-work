/**
 * Plugin names this process may serve from PLUGINS_DIR — an allow-list.
 *
 * Some readers do not go through PluginManager's resolved list: they read PLUGINS_DIR directly
 * (`skill-locator`, `SkillForceHandler`) and have no PluginManager of their own to ask
 * (`skill-locator` is plain functions; the force handler's `mcpManager` is optional and gets its
 * PluginManager only after initialize). A directory on disk is not proof of admission: a name
 * refused for a collision, a plugin blocked by the security scan, or one dropped from config can
 * stay on disk when its deletion fails, and must not come back once the config changes or the
 * process restarts. Those readers serve a PLUGINS_DIR name only when it is in this set.
 *
 * PluginManager is the only writer: at the end of every pass that rebuilds its resolved list
 * (initialize / refresh, forceRefresh, rollback, rebuildResolved) it replaces the set with the
 * PLUGINS_DIR names in that list — the ones admitted this pass. Bundled plugins resolve to the
 * bundle, not PLUGINS_DIR, and are never in it. Before the first pass the set is empty, so nothing
 * from PLUGINS_DIR is served; the daemon runs initialize before it starts taking messages.
 */

let admitted: ReadonlySet<string> = new Set();

/** PluginManager only: the PLUGINS_DIR plugin names its latest pass admitted. */
export function setAdmittedPluginNames(names: Iterable<string>): void {
  admitted = new Set(names);
}

/** Whether `name` (a directory name under PLUGINS_DIR) may be served. */
export function isAdmittedPluginName(name: string): boolean {
  return admitted.has(name);
}
