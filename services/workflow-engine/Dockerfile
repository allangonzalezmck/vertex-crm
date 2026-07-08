# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY shared/src ./shared/src/
COPY services/workflow-engine/package.json services/workflow-engine/tsconfig.json ./services/workflow-engine/
COPY services/workflow-engine/src ./services/workflow-engine/src/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/workflow-engine
RUN npm run build --workspace=@nexus/shared
RUN npm run build --workspace=@nexus/workflow-engine

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

RUN addgroup -S nexus && adduser -S nexus -G nexus

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/shared/package.json ./shared/
COPY --from=builder /app/services/workflow-engine/package.json ./services/workflow-engine/

RUN npm install --workspace=@nexus/shared --workspace=@nexus/workflow-engine --omit=dev

COPY --from=builder /app/shared/dist ./shared/dist/
COPY --from=builder /app/services/workflow-engine/dist ./services/workflow-engine/dist/

USER nexus
EXPOSE 8080
CMD ["node", "services/workflow-engine/dist/app.js"]
