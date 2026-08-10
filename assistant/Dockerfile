FROM node:26-alpine
WORKDIR /app
# Phase 6 owns the final deployment pinning policy. Phase 4 pins the locally
# proven CLI so the container can exercise the same process boundary now.
RUN npm install -g opencode-ai@1.18.10 --no-audit --no-fund
COPY agents.toml opencode.json ./
COPY assistant/ ./assistant/
EXPOSE 8091
CMD ["node", "assistant/server.mjs"]
