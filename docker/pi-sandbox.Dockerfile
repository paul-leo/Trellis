# Dedicated verification image for trellis-pi-mcp-bridge-p4 only — never
# merged into docker/sandbox.Dockerfile, which every other phase's
# acceptance pass also builds; installing the real pi binary here would
# slow down every one of those builds for a dependency only this one
# phase's runtime-code adapter actually needs. Same isolation guarantee as
# the main sandbox: runs entirely against a copy of test/fixtures/home,
# never the fixture files themselves.
FROM node:20-slim

WORKDIR /trellis
COPY package.json package-lock.json tsconfig.json ./
RUN npm install

COPY src ./src
COPY scripts ./scripts
COPY schema ./schema
COPY test/fixtures/sample-mcp-server.js /fixtures/sample-mcp-server.js

RUN node scripts/build-pi-bridge.mjs
RUN npm install -g @earendil-works/pi-coding-agent

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
