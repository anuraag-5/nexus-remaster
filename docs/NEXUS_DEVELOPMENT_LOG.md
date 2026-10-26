# Nexus Rewrite — Development Log

> **Last updated:** 26 October 2026  
> **Purpose:** Quick project overview: what Nexus is, what is done, and what comes next. Update the phase status after each meaningful session.

## Project goal

Rebuild Nexus as a production-style website monitoring SaaS. Users will manage workspaces and website monitors, receive uptime checks and incident alerts, view historical analytics, and eventually choose subscription plans. The project is also a practical path to deepen backend engineering skills.

## Stack and key decisions

- **Monorepo:** pnpm workspaces + Turborepo; apps and shared packages live in one repository.
- **Runtime/API:** Node.js 24 LTS, TypeScript, Express 5.
- **Frontend:** Next.js App Router, React, Tailwind CSS v4.
- **Authentication:** Clerk (Clerk Core 3); Express validates session tokens.
- **Database:** PostgreSQL 17 in Docker Compose; `pg` connection pool; SQL migrations with `node-pg-migrate`.
- **Validation/config:** Zod and dotenv.
- **Testing/logging/security:** Vitest, Supertest, Pino, pino-http, Helmet.
- **Planned jobs:** Redis + BullMQ, with separate scheduler and worker processes.
- **Design principle:** keep the API, scheduler and worker as separate apps/processes in the same monorepo; PostgreSQL is the source of truth. Use parameterised SQL, workspace-level authorization, tests, and versioned migrations.

## Phase 1 — Repository and API foundation ✅ Complete

- Created a fresh Turborepo-style monorepo; retained pnpm rather than restarting with Bun.
- Upgraded to Node.js `24.22.0`; pnpm `11.25.0` works via `pnpm.cmd` in PowerShell.
- Added `apps/api` with Express 5 and TypeScript, reusing the shared TypeScript configuration.
- Added Pino structured/request logging, Helmet security headers, JSON body limits and graceful HTTP shutdown for `SIGINT`/`SIGTERM`.
- Implemented `GET /health/live` and a database-aware `GET /health/ready`.
- Added Vitest + Supertest, separate `tsconfig.test.json`, and checks for health endpoints, security headers, authentication, workspace routes and invalid requests.
- API type-check, build, and the last reported test run succeeded (14 tests passed).

## Phase 2 — Local database and core schema ✅ Complete

- Added `infra/docker-compose.yml` for PostgreSQL 17 Alpine, health check, localhost-only port mapping and a persistent named volume.
- Added validated environment configuration (`src/config/env.ts`) and a shared `pg` pool (`src/lib/db.ts`).
- Added `node-pg-migrate` and successfully applied `20261022000100_create_core_schema.ts`.
- Core tables: `workspaces`, `workspace_members`, `monitors`.
- Added foreign keys, basic constraints and indexes for user membership, workspace monitor lists and due monitor scheduling.
- **Important:** `updated_at` is initialised by a default but still must be maintained on updates. URL length checks do not provide URL safety; SSRF protections are required before workers fetch URLs.

## Phase 3 — Clerk authentication and frontend integration ✅ Complete

- Installed Clerk SDKs in `apps/web` and `apps/api`; configured frontend provider/proxy and sign-up/sign-in UI.
- Updated UI to Clerk Core 3's `Show` component (not deprecated `SignedIn`/`SignedOut`).
- Verified real sign-up works.
- Frontend obtains a Clerk session token and sends it as a Bearer token to Express; `GET /api/v1/me` returns the authenticated user ID.
- Configured CORS for the local frontend origin. CORS is not authentication; API access must still be authorized server-side.

## Phase 4 — Workspace management ✅ Complete

- Implemented workspace creation with a PostgreSQL transaction: insert workspace + owner membership; commit together or roll back.
- Added authenticated `POST /api/v1/workspaces`, strict Zod validation, rejection of client-supplied owner IDs, and generic server error responses.
- Added authenticated `GET /api/v1/workspaces`, filtering by the verified Clerk user ID.
- Added frontend components to create and list workspaces.
- Verified real workspace creation in PostgreSQL: `Stacklify` exists with the signed-in Clerk identity assigned the `owner` role.
- Verified workspace listing works from the frontend.

## Phase 5 — Monitor API ⏳ In progress

- Created `src/monitors/monitor.service.ts` with `createMonitor` and `listMonitors`.
- Service checks workspace membership, uses parameterised SQL, maps database fields to API response fields, and uses transactions/client cleanup.
- `WorkspaceAccessError` is defined for missing/inaccessible workspace cases.
- Type-check and production build passed after adding the service.
- **Not done yet:** monitor router/endpoints, request validation, route wiring, integration tests against PostgreSQL, and frontend monitor creation/listing.

### Next concrete steps

1. Add Zod schemas for monitor name, HTTP/HTTPS URL syntax, interval and timeout.
2. Add `POST` and `GET` monitor routes and wire the service into `createApp()` / `server.ts`.
3. Enforce workspace membership on every monitor operation and use non-disclosing error responses.
4. Add route tests for unauthenticated requests, invalid input, inaccessible workspaces and successful operations.
5. Add PostgreSQL integration tests; verify monitor creation/listing from the real Clerk frontend.

## Future phases — Planned, not implemented

- **Phase 6 — Monitoring engine:** `monitor_checks` schema, scheduler, Redis/BullMQ queue and workers, job identity/idempotency, timeouts and safe retries. Add SSRF protections before any worker fetches user-controlled URLs.
- **Phase 7 — Incidents and notifications:** outage/recovery state transitions, deduplicated alerts, email/webhook delivery and retry tracking.
- **Phase 8 — Analytics:** uptime, response-time percentiles, check history, downtime and incident reports; distinguish target failures from monitoring-system failures.
- **Phase 9 — Subscription model:** Free/Pro/Business plan entitlements, workspace limits, billing state and Stripe test-mode webhooks. Enforce limits on the server, not only in the UI.
- **Phase 10 — Production readiness:** CI quality gates, observability, backups, load/security testing, deployment and final documentation.

## Working rules

- Keep real `.env` files, Clerk secret keys, database credentials and session tokens out of Git and documentation.
- Do not claim planned features are implemented. Update the phase status only after code and verification exist.
- After each session, append only: **what changed, why, how it was tested, and the next step**.
