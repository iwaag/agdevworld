FROM node:26-alpine
WORKDIR /app
# Both standard harnesses are image inputs, not developer-checkout facts.
RUN npm install -g \
    opencode-ai@1.18.10 \
    @anthropic-ai/claude-code@2.1.226 \
    --no-audit --no-fund
COPY agents.toml opencode.json ./
COPY assistant/ ./assistant/
EXPOSE 8091
CMD ["node", "assistant/entrypoint.mjs"]
