FROM node:26-alpine
WORKDIR /app
# The service is Python, but the base stays node: claude_code arrives by npm
# and needs a runtime node anyway, so node-plus-apk-python is the smaller diff
# than python-plus-node — switching the base would buy nothing here.
# `git` is not optional — uv shells out to it for the pyagag git source.
RUN apk add --no-cache python3 uv git
# claude_code is an image input, not a developer-checkout fact. agcode is not
# installed: it ships inside pyagag and runs in this service's own process.
RUN npm install -g \
    @anthropic-ai/claude-code@2.1.226 \
    --no-audit --no-fund
COPY agents.toml ./
COPY assistant/ ./assistant/
# The Python server runs from this venv. `--python /usr/bin/python3` because
# uv's managed CPython is glibc and will not run on Alpine; the MCP tool
# service deliberately stays on that same system interpreter (the claude_code
# MCP config names it, and the native workflow has no venv).
RUN cd /app/assistant && uv sync --frozen --python /usr/bin/python3
EXPOSE 8091
# write_overlay() at boot replaced entrypoint.mjs; no API key value ever
# enters the generated overlay (anthropic_api_key_env only).
CMD ["/app/assistant/.venv/bin/python", "-m", "agdevworld_assistant.server"]
