---
name: dev
description: "Deploy to dev environment. Creates main→deploy/dev PR, merges, and monitors CI deployment to both targets (mac-mini-dev, oudwood-dev)."
---

# dev — Deploy to Dev Environment

Deploys the current `main` branch to the dev environment by pushing to `deploy/dev` and monitoring CI until both deployment targets are confirmed successful.

## Process

### Step 0: Executive Summary of Changes

1. Run `git diff deploy/dev...main` to collect all changes being deployed.
2. Use `local:es` skill to generate an executive summary of the deployment delta.
3. Output the summary to the user.

### Step 1: Create PR and Merge

1. Create a PR from `main` → `deploy/dev`:
   ```bash
   gh pr create --base deploy/dev --head main \
     --title "deploy(dev): $(date +%Y-%m-%d) release" \
     --body "<executive summary from Step 0>"
   ```
2. Merge the PR immediately (no review required for dev):
   ```bash
   gh pr merge <PR_NUMBER> --merge
   ```
3. Output the merged PR link to the user.

### Step 2: Monitor CI Deployment

The `deploy/dev` push triggers the Deploy workflow which deploys to **2 targets**:
- `mac-mini-dev` (runner: `soma-work`, dir: `/opt/soma-work/dev`)
- `oudwood-dev` (runner: `oudwood-512`, dir: `/opt/soma-work/dev`)

**Monitoring loop:**

1. Get the workflow run triggered by the merge:
   ```bash
   gh run list --branch deploy/dev --workflow deploy.yml --limit 1 --json databaseId,status,conclusion
   ```
2. Poll every 30 seconds until the run completes:
   ```bash
   gh run view <RUN_ID> --json status,conclusion,jobs
   ```
3. Check that **both** deploy jobs succeeded:
   - `Deploy mac-mini-dev` — conclusion: `success`
   - `Deploy oudwood-dev` — conclusion: `success`
4. **If any job fails:** Report the failure details to the user and stop.
5. **If both succeed:** Report deployment complete with:
   - PR link
   - Workflow run link
   - Both target statuses
   - Version deployed (from version-bump output if available)

## Output Format

```
✅ Dev deployment complete

PR: <PR_URL>
CI: <WORKFLOW_RUN_URL>

| Target | Status | 
|--------|--------|
| mac-mini-dev | ✅ success |
| oudwood-dev | ✅ success |

Changes deployed: <N> commits, +<add> -<del> (<files> files)
```

## Error Handling

- **PR creation fails (no diff):** Report "deploy/dev is already up to date with main" and stop.
- **Merge conflict:** Report conflict details and ask user to resolve.
- **CI timeout (>10 min):** Report current status and ask user whether to keep waiting.
- **Deployment job failure:** Show job logs summary and suggest `stv:debug`.
