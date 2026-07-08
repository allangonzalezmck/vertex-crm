# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-bullseye AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/embedding-service/package.json services/embedding-service/tsconfig.json ./services/embedding-service/
COPY services/embedding-service/src ./services/embedding-service/src/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/embedding-service
RUN npm run build --workspace=@nexus/shared
RUN npm run build --workspace=@nexus/embedding-service

# ── Runtime stage ─────────────────────────────────────────────────────────────
# Use Debian bullseye (not Alpine) to support Playwright Chromium + system deps
FROM node:20-bullseye-slim AS runtime
WORKDIR /app

# System tools: pdftotext (poppler), docx2txt, yt-dlp, Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    docx2txt \
    chromium \
    chromium-driver \
    python3 \
    python3-pip \
    curl \
    && pip3 install yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN addgroup --system nexus && adduser --system --ingroup nexus nexus

ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CHROMIUM_PATH=/usr/bin/chromium

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/embedding-service/package.json ./services/embedding-service/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/embedding-service --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/embedding-service/dist ./services/embedding-service/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/embedding-service/dist/app.js"]
