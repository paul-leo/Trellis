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
COPY test/fixtures/sample-mcp-server.js /fixtures/sample-mcp-server.js

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
