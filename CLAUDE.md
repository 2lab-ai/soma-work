# Claude Code Slack Bot

This is a TypeScript-based Slack bot that integrates with the Claude Code SDK to provide AI-powered coding assistance directly within Slack workspaces.

## Project Overview

The bot allows users to interact with Claude Code through Slack, providing real-time coding assistance, file analysis, code reviews, and project management capabilities. It supports both direct messages and channel conversations, with sophisticated working directory management and task tracking.

## Architecture

### Core Components

- **`src/index.ts`** - Application entry point and initialization
- **`src/config.ts`** - Environment configuration and validation
- **`src/slack-handler.ts`** - Main Slack event handling and message processing
- **`src/claude-handler.ts`** - Claude Code SDK integration and session management
- **`src/working-directory-manager.ts`** - Working directory configuration and resolution
- **`src/file-handler.ts`** - File upload processing and content embedding
- **`src/image-handler.ts`** - Image conversion and base64 encoding
- **`src/todo-manager.ts`** - Task list management and progress tracking
- **`src/mcp-manager.ts`** - MCP server configuration and management
- **`src/permission-mcp-server.ts`** - MCP server for Slack-based permission prompts
- **`src/shared-store.ts`** - File-based store for inter-process communication
- **`src/github-auth.ts`** - GitHub App authentication and token management
- **`src/git-cli-auth.ts`** - Git CLI authentication utilities
- **`src/user-settings-store.ts`** - File-based user settings persistence
- **`src/logger.ts`** - Structured logging utility
- **`src/stderr-logger.ts`** - Stderr-based logger for MCP servers
- **`src/types.ts`** - TypeScript type definitions

### Key Features

#### 1. Working Directory Management
- **Base Directory Support**: Configure a base directory (e.g., `/Users/username/Code/`) to use short project names
- **Channel Defaults**: Each channel gets a default working directory when the bot is first added
- **Thread Overrides**: Individual threads can override the channel default by mentioning the bot
- **User Defaults**: User's last used directory is saved and auto-applied in new conversations
- **Hierarchy**: Thread-specific > Channel default > User default
- **Smart Resolution**: Supports both relative paths (`cwd project-name`) and absolute paths
- **Persistence**: User settings are stored in `data/user-settings.json` and persist across bot restarts

#### 2. Real-Time Task Tracking
- **Todo Lists**: Displays Claude's planning process as formatted task lists in Slack
- **Progress Updates**: Updates task status in real-time as Claude works
- **Priority Indicators**: Visual priority levels (🔴 High, 🟡 Medium, 🟢 Low)
- **Status Reactions**: Emoji reactions on original messages show overall progress
- **Live Updates**: Single message updates instead of spam

#### 3. File Upload Support
- **Multiple Formats**: Images (JPG, PNG, GIF, WebP), text files, code files, documents
- **Content Embedding**: Text files are embedded directly in prompts
- **Image Analysis**: Images are saved for Claude to analyze using the Read tool
- **Size Limits**: 50MB file size limit with automatic cleanup
- **Security**: Secure download using Slack bot token authentication

#### 4. Advanced Message Handling
- **Streaming Responses**: Real-time message updates as Claude generates responses
- **Tool Formatting**: Rich formatting for file edits, bash commands, and other tool usage
- **Status Indicators**: Clear visual feedback (🤔 Thinking, ⚙️ Working, ✅ Completed)
- **Error Handling**: Graceful error recovery with informative messages
- **Session Management**: Conversation context maintained across interactions

#### 5. Channel Integration
- **Auto-Setup**: Automatic welcome message when added to channels
- **Mentions**: Responds to @mentions in channels
- **Thread Support**: Maintains context within threaded conversations
- **File Uploads**: Handles file uploads in any conversation context

#### 6. MCP (Model Context Protocol) Integration
- **External Tools**: Extends Claude's capabilities with external MCP servers
- **Multiple Server Types**: Supports stdio, SSE, and HTTP MCP servers
- **Auto-Configuration**: Loads servers from `mcp-servers.json` automatically
- **Default Configuration**: Pre-configured with filesystem and GitHub servers
- **Tool Management**: All MCP tools are allowed by default with `mcp__serverName__toolName` pattern
- **Runtime Management**: Reload configuration without restarting the bot
- **Popular Integrations**: Filesystem access, GitHub API (via token), database connections, web search

#### 7. Permission Prompt System
- **Slack-Based Approvals**: Interactive permission prompts via Slack buttons
- **File-Based IPC**: Uses temp directory for cross-process communication between MCP server and Slack handler
- **Timeout Handling**: Automatic denial after configurable timeout period
- **Audit Trail**: Logs all permission requests and responses
- **User Bypass**: Users can enable `bypass` mode to skip permission prompts entirely

## Environment Configuration

### Required Variables
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret
```

### Optional Variables
```env
# Claude Code Configuration (only needed if not using Claude Code subscription)
ANTHROPIC_API_KEY=your-anthropic-api-key

# Working Directory Configuration
BASE_DIRECTORY=/Users/username/Code/

# GitHub App Integration (for MCP) - Recommended
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nYour private key content here...\n-----END RSA PRIVATE KEY-----"
GITHUB_INSTALLATION_ID=12345678

# Legacy GitHub Token Integration (fallback)
GITHUB_TOKEN=ghp_your_personal_access_token

# Third-party API Providers
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1

# Development
DEBUG=true
```

> **Note**: `ANTHROPIC_API_KEY` is optional. If not provided, the bot will use your Claude Code subscription instead.

## Slack App Configuration

### Required Permissions
- `app_mentions:read` - Read mentions
- `channels:history` - Read channel messages
- `chat:write` - Send messages
- `chat:write.public` - Write to public channels
- `im:history` - Read direct messages
- `im:read` - Basic DM info
- `im:write` - Send direct messages
- `users:read` - Read user information
- `reactions:read` - Read message reactions
- `reactions:write` - Add/remove reactions

### Required Events
- `app_mention` - When the bot is mentioned
- `message.im` - Direct messages
- `member_joined_channel` - When bot is added to channels

### Socket Mode
The bot uses Socket Mode for real-time event handling, requiring an app-level token with `connections:write` scope.

### App Manifest
Use `slack-app-manifest.json` as a template when creating your Slack app. It includes all required scopes, events, and settings pre-configured.

## Usage Patterns

### Channel Setup
```
1. Add bot to channel
2. Bot sends welcome message asking for working directory
3. Set default: `cwd project-name` or `cwd /absolute/path`
4. Start using: `@ClaudeBot help me with authentication`
```

### Thread Overrides
```
@ClaudeBot cwd different-project
@ClaudeBot now help me with this other codebase
```

### File Analysis
```
[Upload image/code file]
Analyze this screenshot and suggest improvements
```

### Task Tracking
Users see real-time task lists as Claude plans and executes work:
```
📋 Task List

🔄 In Progress:
🔴 Analyze authentication system

⏳ Pending:  
🟡 Implement OAuth flow
🟢 Add error handling

Progress: 1/3 tasks completed (33%)
```

### MCP Server Management
```
# View configured MCP servers
User: mcp
Bot: 🔧 MCP Servers Configured:
     • filesystem (stdio)
     • github (stdio)  
     • postgres (stdio)

# Reload MCP configuration
User: mcp reload
Bot: ✅ MCP configuration reloaded successfully.

# Use MCP tools automatically
User: @ClaudeBot list all TODO comments in the project
Bot: [Uses mcp__filesystem tools to search files]
```

### Permission Bypass
```
# Check current bypass status
User: bypass
Bot: 🔐 Permission Bypass Status
     Your current setting: OFF
     ✅ Claude will ask for permission before executing sensitive tools.

# Enable bypass (skip all permission prompts)
User: bypass on
Bot: ✅ Permission Bypass Enabled
     Claude will now execute tools without asking for permission.
     ⚠️ Use with caution - this allows Claude to perform actions automatically.

# Disable bypass (require permission prompts)
User: bypass off
Bot: ✅ Permission Bypass Disabled
     Claude will now ask for your permission before executing sensitive tools.
```

### GitHub Integration

GitHub integration is provided through the MCP GitHub server using **GitHub Apps** for better security and granular permissions. This replaces the previous personal access token approach.

#### Setup with GitHub Apps (Recommended)

1. **Create a GitHub App:**

   **Step-by-step instructions:**
   
   a. **Navigate to GitHub Settings:**
      - Go to [github.com](https://github.com) and sign in
      - Click your profile picture in the top right corner
      - Select "Settings" from the dropdown menu
   
   b. **Access Developer Settings:**
      - In the left sidebar, scroll down and click "Developer settings"
      - Click "GitHub Apps"
      - Click "New GitHub App"
   
   c. **Configure the GitHub App:**
      - **GitHub App name**: "Claude Code Slack Bot" (or your preferred name)
      - **Homepage URL**: Your organization's website or the repository URL
      - **Webhook URL**: Leave blank (not used for this integration)
      - **Webhook secret**: Leave blank
      - **Permissions**: Select the following repository permissions:
        - ✅ `Contents` - Read & Write (for reading and modifying files)
        - ✅ `Issues` - Read & Write (for issue management)
        - ✅ `Pull requests` - Read & Write (for PR management)
        - ✅ `Metadata` - Read (for basic repository information)
        - ✅ `Actions` - Read (optional, for viewing CI/CD status)
      - **Organization permissions** (optional):
        - ✅ `Members` - Read (for team information)
      - **User permissions**: None required
      - **Subscribe to events**: None required (we don't use webhooks)
      - **Where can this GitHub App be installed?**: Choose based on your needs
        - "Only on this account" for personal use
        - "Any account" if you plan to share the app
   
   d. **Create the App:**
      - Click "Create GitHub App"
      - You'll be redirected to the app's settings page
   
   e. **Generate Private Key:**
      - Scroll down to "Private keys" section
      - Click "Generate a private key"
      - Download the `.pem` file and store it securely
   
   f. **Note the App ID:**
      - At the top of the app settings page, note the "App ID" (e.g., 123456)

2. **Install the GitHub App:**

   a. **Install on Repositories:**
      - Go to the "Install App" tab in your GitHub App settings
      - Click "Install" next to your account/organization
      - Choose "All repositories" or "Selected repositories" based on your needs
      - Complete the installation
   
   b. **Note the Installation ID:**
      - After installation, you'll see the installation URL
      - The Installation ID is in the URL: `https://github.com/settings/installations/12345678`
      - Note this number (e.g., 12345678)

3. **Configure Environment Variables:**
   ```env
   GITHUB_APP_ID=123456
   GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
   MIIEpAIBAAKCAQEA...
   (your private key content here)
   ...
   -----END RSA PRIVATE KEY-----"
   GITHUB_INSTALLATION_ID=12345678
   ```

   **Important Notes:**
   - The private key should include the full PEM format with line breaks
   - Store the private key securely and never commit it to version control
   - The bot will automatically discover installations if INSTALLATION_ID is not set

#### Legacy Setup with Personal Access Tokens (Fallback)

If you prefer or need to use personal access tokens instead of GitHub Apps:

1. **Generate a Personal Access Token** (following the previous instructions)
2. **Set the environment variable:**
   ```env
   GITHUB_TOKEN=ghp_your_personal_access_token
   ```

The bot will automatically use GitHub App authentication when configured, and fall back to personal access tokens if GitHub App settings are not available.

#### MCP Server Configuration

The project includes a pre-configured `mcp-servers.json` file that automatically sets up:
- **Filesystem server**: Provides access to the working directory
- **GitHub server**: Uses GitHub App authentication when available, or falls back to token authentication
- **Git server**: For Git operations with proper authentication

#### Available GitHub Features
- Repository browsing and file access
- Pull request management
- Issue tracking
- Code search and analysis
- Commit history and diff viewing
- Organization and team management (with proper permissions)

#### Automatic Token Refresh

The bot automatically handles GitHub App token refresh to ensure continuous operation:

**Features:**
- **Automatic Refresh**: Tokens are refreshed 5 minutes before expiry or at 50% of their lifetime (whichever is shorter)
- **Background Processing**: Token refresh happens in the background without interrupting operations
- **Git Credentials Update**: Automatically updates git credentials and environment variables when tokens are refreshed
- **Retry Logic**: If token refresh fails, the system will retry every 2 minutes until successful
- **Graceful Degradation**: Continues to use existing tokens during refresh attempts

**Implementation Details:**
- Tokens are cached until expiry to minimize API calls
- Uses Node.js timers to schedule refresh operations
- Updates both `.git-credentials` file and git global configuration
- Exports `GITHUB_TOKEN` environment variable for child processes
- Automatic cleanup on application shutdown

**Monitoring:**
The bot logs all token refresh activities:
```
GitHub App token refresh scheduled for 2024-01-01T12:00:00.000Z (in 55 minutes)
Background refresh of GitHub App installation token starting
GitHub App installation token refreshed successfully in background
Git credentials updated successfully with refreshed GitHub App token
```

#### Git CLI Authentication

The bot automatically handles GitHub authentication for Git CLI operations performed by Claude Code. When Claude executes Git commands that require GitHub access (push, pull, clone from private repositories), the bot provides the appropriate authentication:

**Authentication Priority:**
1. **GITHUB_TOKEN environment variable** - If set, this token is used directly
2. **GitHub App token** - If GitHub App is configured, an installation token is automatically obtained and used
3. **No authentication** - Commands proceed without authentication (works for public repositories)

**Supported Operations:**
- `git push` to GitHub repositories
- `git pull` from private repositories  
- `git clone` of private repositories
- `git remote set-url` with authenticated URLs

**Automatic Token Injection:**
The bot provides utility functions that automatically prefix Git commands with the appropriate `GITHUB_TOKEN=<token>` when authentication is available:

```typescript
// Available utilities for Claude Code operations
import { getGitHubTokenForCLI, createGitCommand } from './src/git-cli-auth.js';

// Get token for manual use
const token = await getGitHubTokenForCLI();

// Create authenticated Git command
const authenticatedCommand = await createGitCommand('git push origin main');
```

**Environment Variables for Git Operations:**
The bot automatically sets up the following environment variables for MCP servers and Git operations:
- `GITHUB_TOKEN` - Populated from environment variable or GitHub App installation token
- `GITHUB_PERSONAL_ACCESS_TOKEN` - Used by MCP GitHub server

#### Advantages of GitHub Apps over Personal Tokens
- **Better Security**: Apps have granular permissions instead of broad user-level access
- **Institutional Identity**: Actions appear as the app, not a personal user
- **No User Dependency**: Doesn't depend on a specific user's account remaining active
- **Audit Trail**: Better tracking of automated actions
- **Rate Limits**: Higher rate limits for API requests
- **Revocable**: Easy to revoke access without affecting user's personal tokens

## Deployment (macOS)

The bot can run as a background service on macOS using launchd. A management script is provided for easy service control.

### Service Management Script

```bash
# Check service status
./service.sh status

# Start the service
./service.sh start

# Stop the service
./service.sh stop

# Restart the service (apply code changes)
./service.sh restart

# Install as launchd service (first time setup)
./service.sh install

# Uninstall the service
./service.sh uninstall

# View logs
./service.sh logs stderr 100    # Last 100 lines of stderr
./service.sh logs stdout 50     # Last 50 lines of stdout
./service.sh logs follow        # Follow stderr in real-time
./service.sh logs all           # Both stdout and stderr
```

### Service Configuration

The service is managed via launchd with the following configuration:
- **Service Name**: `com.dd.claude-slack-bot`
- **Plist Location**: `~/Library/LaunchAgents/com.dd.claude-slack-bot.plist`
- **Auto-start**: Runs at login (`RunAtLoad: true`)
- **Auto-restart**: Restarts on crash (`KeepAlive: true`)
- **Throttle**: 10 second delay between restart attempts

### Log Files

Logs are stored in the `logs/` directory:
- `logs/stdout.log` - Standard output
- `logs/stderr.log` - Standard error (main application logs)

### Manual Service Control (launchctl)

```bash
# Load/start service
launchctl load ~/Library/LaunchAgents/com.dd.claude-slack-bot.plist

# Unload/stop service
launchctl unload ~/Library/LaunchAgents/com.dd.claude-slack-bot.plist

# Check if running
launchctl list | grep claude
```

## Development

### Build and Run
```bash
npm install
npm run build
npm start       # Run with tsx (development)
npm run dev     # Development with hot reload
npm run prod    # Production mode (requires build first)
```

### Project Structure
```
src/
├── index.ts                      # Entry point
├── config.ts                     # Configuration
├── slack-handler.ts              # Slack event handling
├── claude-handler.ts             # Claude Code SDK integration
├── working-directory-manager.ts  # Directory management
├── file-handler.ts               # File processing
├── image-handler.ts              # Image conversion
├── todo-manager.ts               # Task tracking
├── mcp-manager.ts                # MCP server management
├── permission-mcp-server.ts      # Permission prompt MCP server
├── shared-store.ts               # Inter-process communication store
├── github-auth.ts                # GitHub App authentication
├── git-cli-auth.ts               # Git CLI authentication
├── user-settings-store.ts        # User settings persistence
├── logger.ts                     # Logging utility
├── stderr-logger.ts              # Stderr logger for MCP servers
└── types.ts                      # Type definitions

# Configuration files
mcp-servers.json                  # MCP server configuration
mcp-servers.example.json          # Example MCP configuration
claude-code-settings.json         # Claude Code SDK permissions
slack-app-manifest.json           # Slack app manifest for setup

# Data files (auto-generated)
data/
└── user-settings.json            # Persistent user settings
```

### Key Design Decisions

1. **Append-Only Messages**: Instead of editing a single message, each response is a separate message for better conversation flow
2. **Session-Based Context**: Each conversation maintains its own Claude Code session for continuity
3. **Smart File Handling**: Text content embedded in prompts, images passed as file paths for Claude to read
4. **Hierarchical Working Directories**: Channel defaults with thread overrides for flexibility
5. **Real-Time Feedback**: Status reactions and live task updates for transparency

### Error Handling
- Graceful degradation when Slack API calls fail
- Automatic retry for transient errors
- Comprehensive logging for debugging
- User-friendly error messages
- Automatic cleanup of temporary files

### Claude Code SDK Settings
The `claude-code-settings.json` file configures Claude Code SDK permissions:
```json
{
  "permissions": {
    "allow": [
      "Bash(git clone:*)",
      "Bash(git pull:*)",
      "Bash(git push:*)",
      ...
    ],
    "additionalDirectories": ["/usercontent"]
  }
}
```
This allows Claude to perform git operations and access specified directories without additional prompts.

### Security Considerations
- Environment variables for sensitive configuration
- Secure file download with proper authentication
- Temporary file cleanup after processing
- No storage of user data beyond session duration
- Validation of file types and sizes
- Permission-based access control via `claude-code-settings.json`

## Future Enhancements

Potential areas for expansion:
- Persistent working directory storage (database)
- Advanced file format support (PDFs, Office docs)
- Integration with version control systems
- Custom slash commands
- Team-specific bot configurations
- Analytics and usage tracking