# Leonida Drive multiplayer server. Build from the REPOSITORY ROOT (the server imports src/net/shared,
# src/economy/{rules.js,prices.json,wardrobe-prices.json} and public/data/{world.json,height.bin}):
#   docker build -f server/Dockerfile -t leonida-mp .
#   docker run -d --name leonida-mp -p 127.0.0.1:8787:8787 -v leonida-data:/data \
#     -e ALLOWED_ORIGINS=https://leonida-drive.io -e TRUST_PROXY=1 --ulimit nofile=1048576:1048576 \
#     --stop-timeout 25 leonida-mp
# glibc base: uWebSockets.js ships glibc binaries (Alpine/musl cannot load them). Node 22 or 24 LTS.
FROM node:24-bookworm AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
# the lockfile pins uWebSockets.js to a GitHub commit: fetch it over https (no SSH keys in the build)
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/ \
 && npm ci --omit=dev --no-audit --no-fund \
 && find node_modules/uWebSockets.js -name 'uws_*.node' ! -name 'uws_linux_*' -delete

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DB_PATH=/data/leonida.db WORKERS=auto LOG_LEVEL=info
WORKDIR /app
COPY --from=deps /app/server/node_modules server/node_modules
COPY server/package.json server/
COPY server/src server/src
COPY server/data/vehicles.json server/data/name-blocklist.txt server/data/
COPY src/net/shared src/net/shared
COPY src/economy/rules.js src/economy/prices.json src/economy/wardrobe-prices.json src/economy/
COPY public/data/world.json public/data/height.bin public/data/
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
WORKDIR /app/server
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD ["node", "src/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "src/main.js"]
