FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY build-server.mjs tsconfig.server.json eslint.config.js LICENSE.txt THIRD_PARTY_NOTICES.md README.md ./
COPY tests ./tests
COPY docs ./docs
COPY deploy/Dockerfile deploy/compose.yaml deploy/compose.gpu.yaml deploy/Caddyfile ./deploy/
COPY server ./server
COPY shared ./shared
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
ENV NODE_ENV=production WEB_DIR=/app/dist/web PORT=3000 \
    SEPARATION_STORAGE_DIR=/var/cache/encore-media \
    PATH="/opt/venv/bin:$PATH" HF_HOME=/opt/models TORCH_HOME=/opt/models PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY server/separation-requirements.txt ./server/separation-requirements.txt
# sphn builds from source on ARM64 and needs a C/C++ toolchain and CMake 3.x.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake pkg-config && \
    python3 -m venv /opt/venv && \
    python -m pip install --no-cache-dir --upgrade pip && \
    python -m pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0 --index-url "${TORCH_INDEX_URL}" --extra-index-url https://pypi.org/simple && \
    CMAKE=/usr/bin/cmake python -m pip install --no-cache-dir -r server/separation-requirements.txt && \
    python -c 'from demucs.pretrained import get_model; get_model("htdemucs")' && \
    apt-get purge -y --auto-remove build-essential cmake pkg-config && \
    rm -rf /var/lib/apt/lists/* /root/.cache
ENV HF_HUB_OFFLINE=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /app/dist ./dist
RUN mkdir -p /var/cache/encore-media && chown node:node /var/cache/encore-media
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
