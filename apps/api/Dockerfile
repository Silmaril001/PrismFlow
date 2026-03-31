FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci

FROM deps AS build
COPY apps/api ./apps/api
RUN npm --workspace @shader-mvp/api run build

FROM node:20-bookworm-slim AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci --omit=dev --workspace @shader-mvp/api --include-workspace-root=false
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prompts ./apps/api/prompts
COPY --from=build /app/apps/api/storage ./apps/api/storage
EXPOSE 8788
WORKDIR /app/apps/api
CMD ["node", "dist/index.js"]
