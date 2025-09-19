#!/bin/bash

# Setup Git authentication using GITHUB_TOKEN
if [ -n "$GITHUB_TOKEN" ]; then
    echo "Setting up Git authentication with GitHub token..."
    
    # Configure Git to use the token as credentials
    git config --global credential.helper store
    
    # Set up the credential file with the token
    echo "https://${GITHUB_TOKEN}:x-oauth-basic@github.com" > ~/.git-credentials
    
    # Alternative approach: Configure Git to use token directly
    git config --global credential.https://github.com.username "$GITHUB_TOKEN"
    git config --global credential.https://github.com.helper store
    
    # Set Git user for commits (optional but recommended)
    BOT_NAME="${BOT_NAME:-claudebot}"
    git config --global user.name "$BOT_NAME"
    git config --global user.email "$BOT_NAME@anthropic.com"
    
    echo "Git authentication configured successfully"
else
    echo "Warning: GITHUB_TOKEN not found. Git authentication for private repositories will not work."
fi

# Start the application
exec "$@"