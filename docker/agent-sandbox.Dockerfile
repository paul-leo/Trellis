# Real agent-binary verification image. Kept separate from sandbox.Dockerfile:
# the normal scenario matrix stays fast and deterministic, while this image
# installs the actual public npm CLIs without any account credentials.
FROM node:20-slim

WORKDIR /trellis
COPY package.json package-lock.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY scripts/build-pi-bridge.mjs ./scripts/build-pi-bridge.mjs
COPY schema ./schema
COPY test/fixtures/sample-mcp-server.js /fixtures/sample-mcp-server.js

RUN npm run build && chmod +x /trellis/dist/cli.js && ln -s /trellis/dist/cli.js /usr/local/bin/trellis
RUN npm install -g --no-audit --no-fund @openai/codex
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code
RUN npm install -g --no-audit --no-fund @earendil-works/pi-coding-agent
RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.kiro.dev/install | bash
RUN curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash
ENV PATH="/root/.local/bin:/root/.kiro/bin:/root/.kimi-code/bin:${PATH}"
COPY scripts ./scripts

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
