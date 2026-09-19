# Isolated verification environment for Trellis. See docs/architecture.md
# "Testing philosophy" — nothing that writes (P1+) is ever exercised
# against a developer's real dotfiles. This image runs entirely against a
# copy of test/fixtures/home, never the fixture files themselves, so a
# container run can never mutate what's checked into git.
FROM node:20-slim

WORKDIR /trellis
COPY package.json package-lock.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY scripts ./scripts
COPY schema ./schema
COPY test/fixtures/sample-mcp-server.js /fixtures/sample-mcp-server.js
COPY test/fixtures/memory-mcp-server.js /fixtures/memory-mcp-server.js

# Bundles the pi bridge extension (dist/pi-bridge/bundle.js) — see
# scripts/build-pi-bridge.mjs for why this must be a self-contained
# bundle, not the raw src/pi-bridge/index.ts, before any adapter symlinks
# to it.
RUN node scripts/build-pi-bridge.mjs
RUN npm run build && chmod +x /trellis/dist/cli.js /trellis/scripts/fake-codex.mjs && ln -s /trellis/dist/cli.js /usr/local/bin/trellis && ln -s /trellis/scripts/fake-codex.mjs /usr/local/bin/codex

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
