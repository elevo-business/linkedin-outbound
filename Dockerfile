# Dependency-free core (node:sqlite, node:http) — no `npm install` needed.
# Playwright is optional/heavy and intentionally NOT installed; use the Unipile
# driver in production (recommended for the inbound flow anyway).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# Claude Code CLI — lets the Max plan generate content HEADLESS in the container
# (CONTENT_ENGINE=claude-cli). Authenticate by setting CLAUDE_CODE_OAUTH_TOKEN at
# runtime — generate it once locally with `claude setup-token`. No API key, no
# per-token cost. (If you use CONTENT_ENGINE=claude-api instead, this is unused.)
RUN npm install -g @anthropic-ai/claude-code
# Writable, persisted config dir for the CLI (sessions/credentials live here).
ENV CLAUDE_CONFIG_DIR=/app/data/.claude

COPY . .
RUN mkdir -p /app/data /app/data/.claude

# capture server (3000) + admin dashboard (3001)
EXPOSE 3000 3001

# Overridden per service in docker-compose.yml. Default = the admin dashboard.
CMD ["node", "scripts/admin-server.js"]
