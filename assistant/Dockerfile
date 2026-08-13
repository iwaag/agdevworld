FROM node:26-alpine
WORKDIR /app
# The MCP tool service is Python and stdlib-only; the interpreter is all it needs.
# Which image is the base stays a phase-3 decision.
RUN apk add --no-cache python3
# Both standard harnesses are image inputs, not developer-checkout facts.
RUN npm install -g \
    opencode-ai@1.18.10 \
    @anthropic-ai/claude-code@2.1.226 \
    --no-audit --no-fund
COPY agents.toml opencode.json ./
COPY assistant/ ./assistant/
EXPOSE 8091
CMD ["node", "assistant/entrypoint.mjs"]
