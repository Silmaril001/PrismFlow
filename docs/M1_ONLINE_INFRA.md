# PrismFlow M1 Online Infra Skeleton

This document covers milestone **M1** only:

- static frontend hosting
- containerized API deployment
- persistent app data via PostgreSQL + optional object storage

## 1) Architecture (M1)

- Web (`apps/web`): static hosting (Vercel / Netlify / Cloudflare Pages).
- API (`apps/api`): container runtime with Node.js + ffmpeg support.
- Persistence:
  - `APP_STORE_PROVIDER=memory`: session/revision/artifact/ideation in memory.
  - `APP_STORE_PROVIDER=postgres`: session/revision/artifact/ideation in PostgreSQL.
  - `FAVORITES_PROVIDER=local`: favorites remain filesystem-based.
  - `FAVORITES_PROVIDER=postgres`: favorites in PostgreSQL.
  - `OBJECT_STORAGE_PROVIDER=s3`: favorite cover image uploaded to S3-compatible object storage.

## 2) Frontend Hosting

Use `apps/web/.env.production.example` as baseline:

```env
VITE_API_BASE_URL=https://api.prismflow.example.com
```

Build command:

```bash
npm --workspace @shader-mvp/web run build
```

Output directory:

```text
apps/web/dist
```

SPA fallback is provided by [`apps/web/public/_redirects`](../apps/web/public/_redirects).

## 3) API Container Deployment

Dockerfile: [`apps/api/Dockerfile`](../apps/api/Dockerfile)

Build from repo root:

```bash
docker build -f apps/api/Dockerfile -t prismflow-api:0.1.x .
```

Run:

```bash
docker run --rm -p 8788:8788 --env-file apps/api/.env prismflow-api:0.1.x
```

Health endpoints:

- `GET /health` (liveness)
- `GET /ready` (dependency checks, returns `503` when dependencies fail)

## 4) Persistence Variables

Add these to production API secrets:

```env
APP_STORE_PROVIDER=postgres
FAVORITES_PROVIDER=postgres
POSTGRES_URL=postgres://user:pass@host:5432/dbname
POSTGRES_SSL=true
POSTGRES_AUTO_MIGRATE=true

OBJECT_STORAGE_PROVIDER=s3
S3_ENDPOINT=https://<s3-compatible-endpoint>
S3_REGION=auto
S3_BUCKET=prismflow-assets
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_PUBLIC_BASE_URL=https://cdn.example.com/prismflow-assets
S3_FORCE_PATH_STYLE=true
S3_KEY_PREFIX=prismflow
```

Notes:

- If `APP_STORE_PROVIDER=postgres`, app restarts will not lose session/revision/artifact/ideation records.
- Ideation asset payload is persisted in PostgreSQL (`data_base64`) instead of local persistent files.
- If `OBJECT_STORAGE_PROVIDER=none`, favorites keep inline `data:image/*` cover.
- If `OBJECT_STORAGE_PROVIDER=s3`, favorites cover image is uploaded and persisted as URL.

## 5) M1 Validation Checklist

1. Build both packages:
   - `npm run build`
2. Start API and verify:
   - `/health` returns `ok: true`
   - `/ready` returns `ok: true`
3. Smoke test core API flow:
   - create session
   - generate shader
   - query latest revision
   - export revision
4. Smoke test ideation/favorite flow:
   - send ideation asset message (or verify ideation state after asset binding)
   - create favorite
   - list favorites
   - fetch favorite detail
5. Restart API and recheck persistence when using PostgreSQL providers.

Cloud dependency preflight:

- `npm --workspace @shader-mvp/api run doctor:cloud`
- optional write smoke test: `node apps/api/scripts/doctor-cloud.mjs --strict-online --write-smoke`

Detailed Neon/R2/DO walkthrough:

- [`docs/M1_NEON_R2_DO_PLAYBOOK.md`](./M1_NEON_R2_DO_PLAYBOOK.md)
