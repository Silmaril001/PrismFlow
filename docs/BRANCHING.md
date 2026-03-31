# PrismFlow Branching Strategy

This repo is the online/public-track codebase, isolated from the local personal version.

## Branches

- `main`: production-ready, deployable baseline.
- `dev`: integration branch for upcoming milestones.
- `feature/*`: scoped implementation branches (one feature or task).
- `release/*`: pre-release hardening branches.
- `hotfix/*`: urgent fixes for production issues.

## Workflow

1. Branch from `dev` into `feature/*`.
2. Merge `feature/*` into `dev` after verification.
3. Cut `release/*` from `dev` for launch hardening.
4. Merge `release/*` into `main` for deployment.
5. Back-merge `main` into `dev` after release if needed.

## Milestones Mapping

- M0: isolated online baseline and repo setup.
- M1-M5: tracked on `dev` with milestone-specific `feature/*` branches.
