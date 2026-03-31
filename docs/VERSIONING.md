# PrismFlow Versioning (M0-M5)

## Rule

During the entire M0-M5 rollout, versioning must stay within `0.1.x`.

## Practical Policy

- Start baseline: `0.1.0`
- Every milestone delivery increments patch only:
  - M0 follow-up commits: `0.1.1+`
  - M1..M5 continue as `0.1.x`
- Do not bump minor/major until M5 is completed and accepted.

## Scope

Apply this policy to:

- root package version
- workspace package versions
- release tags and release notes
