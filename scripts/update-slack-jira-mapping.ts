#!/usr/bin/env npx tsx

/**
 * Slack-Jira User Mapping Update Script
 *
 * This script fetches users from both Slack and Jira, matches them by name,
 * and updates the mapping file at ./data/slack_jira_mapping.json
 *
 * Usage:
 *   npx tsx scripts/update-slack-jira-mapping.ts
 *   # or
 *   npm run update-mapping
 */

import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
config({ path: path.join(__dirname, '..', '.env') });

const MAPPING_FILE = path.join(__dirname, '..', 'data', 'slack_jira_mapping.json');

// Jira configuration
const JIRA_CLOUD_ID = process.env.JIRA_CLOUD_ID || 'insightquest.atlassian.net';

interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  deleted: boolean;
  is_bot: boolean;
  is_app_user: boolean;
}

interface JiraUser {
  accountId: string;
  displayName: string;
  active: boolean;
  accountType: string;
}

interface MappingEntry {
  jiraAccountId: string;
  name: string;
  slackName?: string;
  jiraName?: string;
}

interface Mapping {
  [slackId: string]: MappingEntry;
}

async function fetchSlackUsers(): Promise<SlackUser[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN environment variable is required');
  }

  const response = await fetch('https://slack.com/api/users.list', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = (await response.json()) as { ok: boolean; members: SlackUser[]; error?: string };

  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data.members.filter((user) => !user.deleted && !user.is_bot && !user.is_app_user && user.id !== 'USLACKBOT');
}

async function fetchJiraUsers(): Promise<JiraUser[]> {
  // Using Atlassian's user search API
  // Note: This requires proper authentication setup
  const response = await fetch(
    `https://api.atlassian.com/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/users/search?maxResults=1000`,
    {
      headers: {
        Accept: 'application/json',
      },
    },
  );

  if (!response.ok) {
    console.warn('Could not fetch Jira users directly. Using cached/manual matching.');
    return [];
  }

  const data = (await response.json()) as JiraUser[];
  return data.filter((user) => user.active && user.accountType === 'atlassian');
}

function normalizeNameForMatching(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '');
}

function matchUsers(slackUsers: SlackUser[], jiraUsers: JiraUser[]): Mapping {
  const mapping: Mapping = {};

  // Load existing mapping to preserve manual matches
  let existingMapping: Mapping = {};
  try {
    const existingData = fs.readFileSync(MAPPING_FILE, 'utf-8');
    existingMapping = JSON.parse(existingData);
  } catch {
    console.log('No existing mapping file found, creating new one.');
  }

  // Create a map of Jira users by normalized name
  const jiraUserMap = new Map<string, JiraUser>();
  for (const jiraUser of jiraUsers) {
    const normalizedName = normalizeNameForMatching(jiraUser.displayName);
    jiraUserMap.set(normalizedName, jiraUser);
  }

  for (const slackUser of slackUsers) {
    // Check if we have an existing mapping for this Slack user
    if (existingMapping[slackUser.id]) {
      mapping[slackUser.id] = {
        ...existingMapping[slackUser.id],
        slackName: slackUser.name,
      };
      continue;
    }

    // Try to match by name
    const normalizedRealName = normalizeNameForMatching(slackUser.real_name);
    const normalizedName = normalizeNameForMatching(slackUser.name);

    const matchedJiraUser = jiraUserMap.get(normalizedRealName) || jiraUserMap.get(normalizedName);

    if (matchedJiraUser) {
      mapping[slackUser.id] = {
        jiraAccountId: matchedJiraUser.accountId,
        name: matchedJiraUser.displayName,
        slackName: slackUser.name,
        jiraName: matchedJiraUser.displayName,
      };
    } else {
      // No match found - create entry without Jira ID
      console.warn(`No Jira match found for Slack user: ${slackUser.real_name} (${slackUser.name})`);
    }
  }

  return mapping;
}

function loadCurrentMapping(): Mapping {
  try {
    const data = fs.readFileSync(MAPPING_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return {};
  }
}

function saveMapping(mapping: Mapping): void {
  const dir = path.dirname(MAPPING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2) + '\n');
  console.log(`Mapping saved to: ${MAPPING_FILE}`);
}

function printMapping(mapping: Mapping): void {
  console.log('\n=== Slack-Jira User Mapping ===\n');
  console.log('| Slack ID | Slack Name | Jira Name | Jira Account ID |');
  console.log('|----------|------------|-----------|-----------------|');

  for (const [slackId, entry] of Object.entries(mapping)) {
    console.log(`| ${slackId} | ${entry.slackName || entry.name} | ${entry.name} | ${entry.jiraAccountId} |`);
  }

  console.log(`\nTotal: ${Object.keys(mapping).length} users mapped`);
}

// CLI commands
async function addMapping(slackId: string, jiraAccountId: string, name: string): Promise<void> {
  const mapping = loadCurrentMapping();
  mapping[slackId] = { jiraAccountId, name };
  saveMapping(mapping);
  console.log(`Added mapping: ${slackId} -> ${jiraAccountId} (${name})`);
}

async function removeMapping(slackId: string): Promise<void> {
  const mapping = loadCurrentMapping();
  if (mapping[slackId]) {
    delete mapping[slackId];
    saveMapping(mapping);
    console.log(`Removed mapping for: ${slackId}`);
  } else {
    console.log(`No mapping found for: ${slackId}`);
  }
}

async function listMapping(): Promise<void> {
  const mapping = loadCurrentMapping();
  printMapping(mapping);
}

async function syncFromApis(): Promise<void> {
  console.log('Fetching Slack users...');
  const slackUsers = await fetchSlackUsers();
  console.log(`Found ${slackUsers.length} Slack users`);

  console.log('Fetching Jira users...');
  const jiraUsers = await fetchJiraUsers();
  console.log(`Found ${jiraUsers.length} Jira users`);

  console.log('Matching users...');
  const mapping = matchUsers(slackUsers, jiraUsers);

  saveMapping(mapping);
  printMapping(mapping);
}

// Main entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'list';

  switch (command) {
    case 'sync':
      await syncFromApis();
      break;

    case 'add':
      if (args.length < 4) {
        console.error('Usage: update-slack-jira-mapping.ts add <slackId> <jiraAccountId> <name>');
        process.exit(1);
      }
      await addMapping(args[1], args[2], args[3]);
      break;

    case 'remove':
      if (args.length < 2) {
        console.error('Usage: update-slack-jira-mapping.ts remove <slackId>');
        process.exit(1);
      }
      await removeMapping(args[1]);
      break;

    case 'list':
      await listMapping();
      break;

    default:
      console.log(`
Slack-Jira User Mapping Tool

Usage:
  npx tsx scripts/update-slack-jira-mapping.ts <command>

Commands:
  list                              List current mappings
  sync                              Fetch users from APIs and update mappings
  add <slackId> <jiraId> <name>     Add a manual mapping
  remove <slackId>                  Remove a mapping

Examples:
  npx tsx scripts/update-slack-jira-mapping.ts list
  npx tsx scripts/update-slack-jira-mapping.ts add U12345 712020:abc-123 "John Doe"
  npx tsx scripts/update-slack-jira-mapping.ts remove U12345
`);
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
