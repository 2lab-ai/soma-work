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
- **`src/todo-manager.ts`** - Task list management and progress tracking
- **`src/mcp-manager.ts`** - MCP server configuration and management
- **`src/logger.ts`** - Structured logging utility
- **`src/types.ts`** - TypeScript type definitions

### Key Features

#### 1. Working Directory Management
- **Base Directory Support**: Configure a base directory (e.g., `/Users/username/Code/`) to use short project names
- **Channel Defaults**: Each channel gets a default working directory when the bot is first added
- **Thread Overrides**: Individual threads can override the channel default by mentioning the bot
- **Hierarchy**: Thread-specific > Channel default > DM-specific
- **Smart Resolution**: Supports both relative paths (`cwd project-name`) and absolute paths

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

## Environment Configuration

### Required Variables
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token  
SLACK_SIGNING_SECRET=your-signing-secret

# Claude Code Configuration
ANTHROPIC_API_KEY=your-anthropic-api-key
```

### Optional Variables
```env
# Working Directory Configuration
BASE_DIRECTORY=/Users/username/Code/

# GitHub Integration (for MCP)
GITHUB_TOKEN=ghp_your_personal_access_token

# Third-party API Providers
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_CODE_USE_VERTEX=1

# Development
DEBUG=true
```

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

### GitHub Integration

GitHub integration is provided through the MCP GitHub server using a personal access token:

#### Setup
1. **Generate a GitHub Personal Access Token:**

   **Step-by-step instructions:**
   
   a. **Navigate to GitHub Settings:**
      - Go to [github.com](https://github.com) and sign in
      - Click your profile picture in the top right corner
      - Select "Settings" from the dropdown menu
   
   b. **Access Developer Settings:**
      - In the left sidebar, scroll down and click "Developer settings"
      - Click "Personal access tokens"
      - Select "Tokens (classic)"
   
   c. **Generate New Token:**
      - Click "Generate new token (classic)"
      - You may be prompted to confirm your password
   
   d. **Configure Token:**
      - **Note**: Give it a descriptive name like "Claude Code Slack Bot"
      - **Expiration**: Choose an appropriate expiration (90 days, 1 year, or no expiration)
      - **Select scopes** based on your needs:
        - ✅ `repo` - Full control of private repositories (includes all repo permissions)
        - ✅ `read:org` - Read organization membership and team membership
        - ✅ `read:user` - Read user profile data
        - ✅ `user:email` - Access user email addresses (read-only)
   
   e. **Generate and Save Token:**
      - Click "Generate token" at the bottom
      - **Important**: Copy the token immediately - you won't be able to see it again
      - Store it securely (password manager, secure notes, etc.)
   
   **Token Format**: The token will look like `ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`

   **Security Notes:**
   - Treat this token like a password - never share it publicly
   - Don't commit it to version control
   - Use environment variables or secure secret management
   - Consider setting an expiration date for better security
   - You can regenerate the token anytime if compromised

   **Permission Explanation:**
   - `repo`: Grants full access to repositories (read, write, admin)
   - `read:org`: Allows reading organization membership and team membership
   - `read:user`: Allows reading basic user profile information
   - `user:email`: Allows reading user email addresses

2. Add the token to your environment:
   ```env
   GITHUB_TOKEN=ghp_your_personal_access_token
   ```

3. **Configure MCP Server:**
   The project includes a pre-configured `mcp-servers.json` file that automatically sets up:
   - **Filesystem server**: Provides access to the working directory
   - **GitHub server**: Activated when `GITHUB_TOKEN` environment variable is provided
   
   For Docker deployment, no additional MCP configuration is needed. For local development, you can modify `mcp-servers.json` as needed.

#### Available GitHub Features
- Repository browsing and file access
- Pull request management
- Issue tracking
- Code search and analysis
- Commit history and diff viewing

## Development

### Build and Run
```bash
npm install
npm run build
npm run dev     # Development with hot reload
npm run prod    # Production mode
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
├── todo-manager.ts               # Task tracking
├── mcp-manager.ts                # MCP server management
├── logger.ts                     # Logging utility
└── types.ts                      # Type definitions

# Configuration files
mcp-servers.json                  # MCP server configuration
mcp-servers.example.json          # Example MCP configuration
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

### Security Considerations
- Environment variables for sensitive configuration
- Secure file download with proper authentication
- Temporary file cleanup after processing
- No storage of user data beyond session duration
- Validation of file types and sizes

## Future Enhancements

Potential areas for expansion:
- Persistent working directory storage (database)
- Advanced file format support (PDFs, Office docs)
- Integration with version control systems
- Custom slash commands
- Team-specific bot configurations
- Analytics and usage tracking