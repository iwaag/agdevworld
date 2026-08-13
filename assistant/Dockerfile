FROM node:26-alpine
WORKDIR /app
# The MCP tool service is Python and stdlib-only; the interpreter is all it
# needs. `git` is not optional — uv shells out to it for the pyagag git source.
# Which image is the base stays a phase-3 decision.
RUN apk add --no-cache python3 uv git
# Both standard harnesses are image inputs, not developer-checkout facts.
RUN npm install -g \
    opencode-ai@1.18.10 \
    @anthropic-ai/claude-code@2.1.226 \
    --no-audit --no-fund
COPY agents.toml opencode.json ./
COPY assistant/ ./assistant/
# The Python server runs from this venv. `--python /usr/bin/python3` because
# uv's managed CPython is glibc and will not run on Alpine; the MCP tool
# service deliberately stays on that same system interpreter (opencode.json
# names it, and the native workflow has no venv).
RUN cd /app/assistant && uv sync --frozen --python /usr/bin/python3
EXPOSE 8091
CMD ["node", "assistant/entrypoint.mjs"]
