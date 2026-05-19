#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const bundleRoot = path.resolve(process.argv[2] || path.join(repoRoot, '.deploy-bundle'));

const requiredRootFiles = [
  'package.json',
  'package-lock.json',
  'scripts/service.sh',
  'scripts/smoke/mcp-bins.js',
  'scripts/smoke/resvg-native.js',
  'scripts/deploy/sync-bundle.sh',
  'scripts/deploy/install-target.sh',
  'deploy/protected-paths.txt',
  'dist/index.js',
  'dist/deploy/main-env-bootstrap.js',
];

const protectedPaths = ['.env', '.system.prompt', 'config.json', 'mcp-servers.json', 'data/', 'logs/', '.claude/'];

let failures = 0;

function fail(message) {
  console.error(message);
  failures++;
}

function exists(relativePath) {
  return fs.existsSync(path.join(bundleRoot, relativePath));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(bundleRoot, relativePath), 'utf8'));
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    visit(fullPath, entry);
    if (entry.isDirectory()) {
      walk(fullPath, visit);
    }
  }
}

function listPackageJsons() {
  const packagesDir = path.join(bundleRoot, 'packages');
  const manifests = [];
  walk(packagesDir, (fullPath, entry) => {
    if (entry.isFile() && entry.name === 'package.json') {
      manifests.push(fullPath);
    }
  });
  return manifests.sort();
}

if (!fs.existsSync(bundleRoot)) {
  fail(`Deploy bundle does not exist: ${bundleRoot}`);
} else {
  for (const file of requiredRootFiles) {
    if (!exists(file)) {
      fail(`Missing required deploy bundle file: ${file}`);
    }
  }

  const protectedFile = path.join(bundleRoot, 'deploy/protected-paths.txt');
  if (fs.existsSync(protectedFile)) {
    const actualProtected = fs.readFileSync(protectedFile, 'utf8').split(/\r?\n/).filter(Boolean);
    for (const protectedPath of protectedPaths) {
      if (!actualProtected.includes(protectedPath)) {
        fail(`Missing protected path: ${protectedPath}`);
      }
    }
  }

  const disallowedDirs = new Set(['node_modules', 'src', '__tests__']);
  walk(bundleRoot, (fullPath, entry) => {
    const relativePath = path.relative(bundleRoot, fullPath).split(path.sep).join('/');
    if (entry.isDirectory() && disallowedDirs.has(entry.name)) {
      fail(`Deploy bundle contains disallowed directory: ${relativePath}`);
    }
    if (entry.isFile() && /\.test\.[cm]?[jt]s$/.test(entry.name)) {
      fail(`Deploy bundle contains test file: ${relativePath}`);
    }
  });

  const packageJsons = listPackageJsons();
  if (packageJsons.length === 0) {
    fail('Deploy bundle contains no workspace package manifests');
  }

  for (const manifestPath of packageJsons) {
    const packageDir = path.dirname(manifestPath);
    const relativePackageDir = path.relative(bundleRoot, packageDir).split(path.sep).join('/');
    const manifest = readJson(path.relative(bundleRoot, manifestPath));
    const distDir = path.join(packageDir, 'dist');

    if (!fs.existsSync(distDir)) {
      fail(`Workspace package missing dist output: ${relativePackageDir}`);
      continue;
    }

    if (!fs.readdirSync(distDir).length) {
      fail(`Workspace package has empty dist output: ${relativePackageDir}`);
    }

    if (manifest.name?.startsWith('@soma/mcp-server-')) {
      const binExport = manifest.exports?.['./bin'];
      if (typeof binExport !== 'string') {
        fail(`MCP package missing exports["./bin"]: ${manifest.name}`);
      } else if (!fs.existsSync(path.join(packageDir, binExport))) {
        fail(`MCP package bin export target missing for ${manifest.name}: ${binExport}`);
      }

      const binTargets = Object.values(manifest.bin || {});
      if (binTargets.length !== 1) {
        fail(`MCP package must define exactly one bin target: ${manifest.name}`);
      }
      for (const binTarget of binTargets) {
        if (!fs.existsSync(path.join(packageDir, binTarget))) {
          fail(`MCP package bin target missing for ${manifest.name}: ${binTarget}`);
        }
      }
    }
  }
}

if (failures > 0) {
  process.exit(1);
}

console.log(`OK deploy bundle: ${bundleRoot}`);
