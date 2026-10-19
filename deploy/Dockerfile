FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY build-server.mjs tsconfig.server.json eslint.config.js LICENSE.txt THIRD_PARTY_NOTICES.md README.md ./
COPY tests ./tests
COPY docs ./docs
COPY deploy/Dockerfile deploy/compose.yaml deploy/Caddyfile ./deploy/
COPY server ./server
COPY shared ./shared
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data LIBRARY_DIR=/library WEB_DIR=/app/dist/web PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
# The desktop native dependencies are unnecessary in the server image.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir /data /cache /library && chown node:node /data /cache
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
