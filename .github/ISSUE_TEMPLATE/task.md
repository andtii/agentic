---
name: Task (sub-issue of the tracking issue)
about: A cold-start-friendly unit of work an agent can execute from this body plus docs/architecture.md
title: "<area>: <what>"
labels: ["phase:1-foundations"]
---

## Goal

<one paragraph: what exists when this is done>

## Requirements

<IDs from docs/requirements.md, e.g. COL-04, COL-05>

## Owner paths

<the only paths this issue may touch, e.g. `packages/platform/src/task/**`>

## Depends on

<issue numbers that must be merged first, or "none">

## Scope

- <bullet>

## Out of scope

- <bullet>

## Acceptance

- [ ] <testable statement>

## Verify

```sh
pnpm typecheck && pnpm test <path> && pnpm size
```

## Read first

docs/architecture.md § <section>
