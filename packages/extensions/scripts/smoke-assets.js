#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const requiredAssets = [
  'assets/local/hooks/todo-guard.sh',
  'assets/local/hooks/hook-proxy.sh',
  'assets/local/hooks/stop-hook.sh',
  'assets/local/skills/z/SKILL.md',
  'assets/prompt/default.prompt',
  'assets/prompt/workflows/deploy.prompt',
  'assets/persona/default.md',
];

let failures = 0;

function fail(message) {
  console.error(message);
  failures++;
}

for (const asset of requiredAssets) {
  const fullPath = path.join(packageRoot, asset);
  if (!fs.existsSync(fullPath)) {
    fail(`MISSING ${asset}`);
    continue;
  }
  if (asset.endsWith('.sh') && (fs.statSync(fullPath).mode & 0o111) === 0) {
    fail(`NOT EXECUTABLE ${asset}`);
  }
}

const hooksDir = path.join(packageRoot, 'assets/local/hooks');
if (fs.existsSync(hooksDir)) {
  for (const entry of fs.readdirSync(hooksDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.sh')) continue;
    const fullPath = path.join(hooksDir, entry.name);
    if ((fs.statSync(fullPath).mode & 0o111) === 0) {
      fail(`NOT EXECUTABLE assets/local/hooks/${entry.name}`);
    }
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`OK extension assets: ${packageRoot}`);
