FROM node:26-alpine
WORKDIR /app
# The claude backend uses the official Anthropic SDK; the ollama default needs
# nothing. Install first so the layer caches across server.mjs edits.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs GUIDE.md ./
EXPOSE 8091
CMD ["node", "server.mjs"]
