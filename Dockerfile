# Dependency-free core (node:sqlite, node:http) — no `npm install` needed.
# Playwright is optional/heavy and intentionally NOT installed; use the Unipile
# driver in production (recommended for the inbound flow anyway).
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production
COPY . .
RUN mkdir -p /app/data

# capture server (3000) + admin dashboard (3001)
EXPOSE 3000 3001

# Overridden per service in docker-compose.yml. Default = the admin dashboard.
CMD ["node", "scripts/admin-server.js"]
