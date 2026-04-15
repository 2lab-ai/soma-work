# Use Node.js LTS on Debian Bookworm (Alpine lacks glibc — faster-whisper/ctranslate2 won't build)
FROM node:18-bookworm-slim

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl bash coreutils findutils grep sed openssl ca-certificates gnupg \
    ripgrep \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (requires separate Debian repo)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null && \
    apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Create non-root user EARLY (before copies that target /home/nodejs)
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/bash -m nodejs

# Install A2T Python dependencies in isolated venv (copy requirements early for build cache)
COPY services/a2t/requirements.txt /tmp/a2t-requirements.txt
RUN python3 -m venv /opt/a2t-venv && \
    /opt/a2t-venv/bin/pip install --no-cache-dir -r /tmp/a2t-requirements.txt && \
    rm /tmp/a2t-requirements.txt
ENV PATH="/opt/a2t-venv/bin:$PATH"

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Install tsx globally
RUN npm install -g tsx

# Install MCP servers globally for GitHub app integration
RUN npm install -g @modelcontextprotocol/server-filesystem@latest
RUN npm install -g @modelcontextprotocol/server-github@latest

# Copy source code
COPY . .

# Copy Claude Code settings with correct ownership (user exists, so --chown works)
COPY --chown=nodejs:nodejs claude-code-settings.json /home/nodejs/.claude/settings.json

# Copy and make the setup script executable
COPY setup-git-auth.sh /usr/local/bin/setup-git-auth.sh
RUN chmod +x /usr/local/bin/setup-git-auth.sh

# Create directories and fix ownership
RUN mkdir -p /usercontent && \
    mkdir -p /home/nodejs/.cache && \
    chown -R nodejs:nodejs /app && \
    chown -R nodejs:nodejs /usercontent && \
    chown -R nodejs:nodejs /home/nodejs

# Set environment variable for base directory
ENV BASE_DIRECTORY=/usercontent

USER nodejs

# Expose the port
EXPOSE $PORT

# Start both the healthcheck server and the main application
CMD ["/bin/bash", "-c", "source /usr/local/bin/setup-git-auth.sh && node healthcheck.js & npm run start"]
