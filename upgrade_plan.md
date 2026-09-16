# Investigation Chart — Upgrade Execution Plan

**Branch:** `upgrade` (created from `main` @ `f826679`)
**Companion document:** `UPGRADE.md` — the *why*: full audit, 44 findings with file:line references,
target architecture, RBAC catalogue. This file is the *how*: ordered, checkable work items.

Finding IDs referenced below (`S1`, `U3`, `B2`, …) are defined in `UPGRADE.md` §3–5.

---

## How to use this document

- Phases run in order. Phase 1 must land before anything else — until it does, patient data is
  readable without credentials (verified: `POST /api/search` with no auth returns HTTP 200).
- Tick boxes as work completes. Each phase has **exit criteria** that must pass before moving on.
- One commit per task group, not one giant commit. Keeps `git bisect` useful and review sane.
- Nothing merges to `main` until the phase's exit criteria pass.

---

## Ground rules

| Rule | Reason |
|---|---|
| No new framework, router, state library, or CSS framework | The app is small and should stay small. |
| Pin exact dependency versions (no `^`) | Reproducible builds; avoids surprise majors. |
| Every RBAC check enforced server-side; UI hiding is cosmetic only | A React-only check is not a check. |
| No PHI in logs, audit records, or error messages — identifiers only | Logs get shipped and read widely. |
| Every phase ends with the client build passing and the test suite green | No "fix it in the next phase". |
| `server/.env` stays untracked; `.env.example` documents every new key | Already correct — keep it that way. |

### Commit message convention

```
phase1: add requireAuth middleware and cookie sessions
phase1: validate regNo before EMR query (fixes S2)
phase2: add roles collection and requirePermission gate
```

---

## Dependency graph

```
Phase 0 (prep)
   │
   ▼
Phase 1 (critical security) ──────── MUST COMPLETE FIRST
   │
   ├──────────────┐
   ▼              ▼
Phase 2 (RBAC)   Phase 3 (backend hardening / perf)   ← can run in parallel
   │              │
   └──────┬───────┘
          ▼
     Phase 4 (UX & design)      ← needs Phase 2's /api/auth/me for permission-shaped UI
          │
          ▼
     Phase 5 (operational maturity)
```

Phase 3 has no dependency on Phase 2. If two people are working, split them here.

---

## Decisions needed before starting

These block specific tasks. Answers change the work, so settle them early.

| # | Decision | Options | Blocks | My recommendation |
|---|---|---|---|---|
| D1 | Session mechanism | httpOnly cookie + Mongo session **vs** JWT | 1.2 | **Cookie + Mongo session** — allows instant revocation and role changes; no token readable by injected JS. Remove the unused `JWT_SECRET` from `.env`. |
| D2 | Authoritative user store | Mongo only **vs** Mongo ∪ `auth.json` (today) | 1.5 | **Mongo only.** `auth.json` becomes seed-only. Today's union means removing a user from Mongo does not remove them (B10). |
| D3 | Password rotation | Rotate all 4 now **vs** rotate later | 1.6 | **Rotate now.** They are in git history; `git rm --cached` cannot undo that. |
| D4 | Validation approach | Hand-rolled **vs** `zod` | 1.4 | **Hand-rolled** for Phase 1 (2 routes, ~30 lines, zero new deps). Revisit if routes multiply. |
| D5 | Role list | Confirm the 6 roles in `UPGRADE.md` §7.1 | 2.1 | Needs your clinical/compliance sign-off — I cannot decide which test groups are sensitive. **Still open.** The 6 roles are seeded and enforced, but two values are placeholders awaiting sign-off: `nurse.sensitiveTestGroups: ['HIV','GENETIC']` and whether `lab_tech` should hold `investigation:view_chart`. Meanwhile `user1`–`user3` are all `front_desk` (existence checks only) — deliberately the least-privilege holding position, not a recommendation. Nobody but `admin` can see a result until you assign real roles. |
| D6 | Mongo exposure | Keep `3000:27017` published **vs** bind localhost | 1.7 | **Done for the bind** (`127.0.0.1:3000`, plus the server's `2000`). Mongo auth is **still not enabled** — any process on this host reaches the credential store unauthenticated. |
| D7 | EMR raw SQL | Ask EMR team for a parameterised endpoint | 1.4 / 3.x | Raise now — it is a long lead time and edge validation is only a mitigation, not a fix. |

---

# Phase 0 — Preparation

**Goal:** clean workspace, verified baseline, nothing surprising later.
**Effort:** ~1 hour · **Risk:** none

- [x] **0.1** Confirm `upgrade` branch is checked out and `main` is untouched
      — verified: on `upgrade`, `main` still at `f826679`
- [x] **0.2** Record the baseline: `npm run build --prefix client` passes; capture current search
      latency for a patient with ~10 orders (needed to prove Phase 3's improvement)
      — build green in ~0.8s. Latency against `:2999` (host dev server):

      | regNo | Range | Rows | Chart dates | Wall time |
      |---|---|---|---|---|
      | 4314566 | 2026-06-01 → 07-21 | 915 | 22 | **80.62s** |
      | 4625656 | 2026-07-20 → 07-21 | 70 | 2 | 23.71s |
      | 4975109 | 2025-01-01 → 01-31 | 0 | 0 | 4.74s |

      The 80s case is the Phase 3 target. Roughly linear in chart dates, which matches
      B2's diagnosis: one sequential EMR round trip per order.
- [x] **0.3** Back up the Mongo `auth` collection before any schema change
      — `mongodump` is not installed on this host, so added `scripts/backup-auth.js` using the
      existing `mongodb` driver. 4 docs saved to `backups/auth-<ts>.json` (mode 0600, gitignored).
      Restore verified byte-identical into a throwaway db, then dropped.
- [x] **0.4** Add a test script to `server/package.json`: `"test": "node --test"`
      — added, plus `test:watch`
- [x] **0.5** Verify the seven `server/test_*.js` files still run or mark them for deletion — only
      `test_auth.js` uses `node:test`, and its single assertion is near-worthless (B6)
      — `test_*.js` is **not** matched by Node's default discovery (it wants `*.test.js`,
      `*-test.js`, or `test/**`), so `npm test` found zero tests. Renamed `test_auth.js` →
      `auth.test.js` (now discovered) and moved the other six live-EMR probes to
      `server/manual/` with a README and fixed relative imports. Kept rather than deleted —
      they document EMR behaviour needed for Phase 3's characterisation tests.
- [x] **0.6** Fix the README's wrong ports: `8080`/`3001`/`6001` → `1000`/`2000` (B9)
      — all six occurrences; added the Mongo row to the services table
- [x] **0.7** Delete stale tracked artifacts: `server.zip`, `client/dist.zip`, `dummy.json` (S16)
      — `git rm --cached` (left on disk) and added `*.zip` / `dummy.json` to `.gitignore`
- [ ] **0.8** Confirm docker access works for whoever runs the rebuild (this shell lacks it —
      not in the `docker` group, and `sudo` needs interactive auth) — **still open, needs you**

**Exit criteria:** clean `git status` apart from intended changes; client build green; baseline
latency recorded; Mongo backup stored somewhere safe. — **met**, except 0.8 which needs your shell.

**Found while doing 0.6 (not fixed, needs your call):** `client/vite.config.js:10` proxies `/api`
to `http://localhost:6001`, but `server/.env` sets `PORT=2000` and `config.js:6` only falls back
to `6001`. So `npm run dev` starts the API on 2000 while Vite forwards to 6001 — the dev proxy is
broken for anyone not manually overriding the port. Left alone because a server is currently
listening on `:2999` in this environment and I did not want to disturb it. Fix belongs with 1.8.

---

# Phase 1 — Critical security (NOT OPTIONAL)

**Goal:** patient data unreachable without valid credentials; injection vector closed; passwords
hashed.
**Effort:** 1–2 days · **Risk:** medium (touches every route and the login path)
**Fixes:** S1, S2, S3, S4, S5, S6, S7, S8, S9, S11, S14, B10

> Until this phase ships, the app is one unauthenticated HTTP request away from disclosing PHI.
> Treat it as a hotfix, not a feature.

## 1.1 Install dependencies (pinned)

- [ ] `cd server && npm install --save-exact bcrypt@6.0.0 helmet@8.3.0 express-rate-limit@8.6.2 cookie-parser@1.4.7`
- [ ] Confirm `bcrypt`'s native build succeeds inside the Docker image (`node:22-alpine` needs
      build tooling). **If it fails, switch to `bcryptjs` rather than adding build-essential to the
      image** — slower, pure JS, no compile step. Decide by testing, not guessing.

## 1.2 Server-side sessions (S3)

- [ ] Create `server/src/services/sessionService.js`
  - `createSession(user, ip, userAgent)` → opaque 32-byte `crypto.randomBytes` hex ID
  - Store `{_id, userId, username, role, ip, userAgent, createdAt, lastSeenAt, expiresAt}` in Mongo
  - TTL index on `expiresAt` so expiry is automatic, not application-managed
  - `getSession(id)`, `touchSession(id)` (slide idle window), `destroySession(id)`,
    `destroyAllForUser(userId)` (needed for force-logout in Phase 2)
- [ ] Create `server/src/middleware/auth.js` → `requireAuth`
  - Read `sid` cookie → look up session → 401 `{code:'SESSION_INVALID'}` if absent/expired
  - Idle > 30 min → destroy + 401 `{code:'SESSION_IDLE'}`
  - Attach `req.user = {userId, username, role}` and slide `lastSeenAt`
- [ ] Set cookie on login: `httpOnly; sameSite:'strict'; secure: NODE_ENV==='production'; maxAge: 8h`
  - `secure` must be conditional or local HTTP dev breaks

## 1.3 Protect the data routes (S1) ← the actual fix

- [ ] `app.use(cookieParser())`
- [ ] `POST /api/search` → add `requireAuth`
- [ ] `GET /api/detail/:orderid` → add `requireAuth`
- [ ] `GET /api/config/hospital` → add `requireAuth` (leaks hospital config today; low value to an
      attacker but no reason to expose it)
- [ ] Leave `GET /api/health` public — orchestration needs it
- [ ] Restructure routes: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`.
      Keep `POST /api/login` as a deprecated alias for one release so a stale client bundle does not
      hard-fail during rollout.
- [ ] **Verify with curl that unauthenticated `/api/search` now returns 401, not 200.** This single
      check is the point of the whole phase.

## 1.4 Input validation (S2) ← closes the injection

- [ ] Create `server/src/middleware/validate.js`
- [ ] `regNo` must match `/^(IP)?\d{1,15}$/i` — **whitelist, not blacklist**. Reject, do not sanitise;
      sanitising a value that gets interpolated into SQL is a losing game.
- [ ] Dates: real calendar dates, `from <= to`, span within the role's ceiling (Phase 2 supplies the
      per-role number; hard-code a sane max here for now)
- [ ] `orderid` already validates `/^\d+$/` — move it into the same middleware for consistency
- [ ] Reject with 400 and a generic message; log the offending value server-side only
- [ ] Add unit tests for the validator, including the injection payloads it must reject
      (`4975109' OR 1=1--`, `'; DROP …`, quotes, semicolons, unicode quotes)
- [ ] **Raise D7 with the EMR team.** Edge validation is a mitigation. As long as the app posts a
      raw `strQuery` string, the design remains one bad input away from arbitrary DB execution.

## 1.5 Password hashing (S4, S14, B10)

These four must land in a **single commit** — a partial migration locks everyone out.

- [ ] `auth.json` schema → `{username, passwordHash, role, displayName, active}`
- [ ] `scripts/update-auth.js`: hash with `bcrypt.hash(pw, 12)` on write; never log plaintext;
      make the run idempotent (skip re-hashing an already-hashed value)
- [ ] `authService.js`: `bcrypt.compare()` instead of `===` (also fixes the timing leak, S14)
- [ ] One-time migration for the 4 existing plaintext Mongo documents
- [ ] **Remove the `auth.json` fallback at login time** (D2/B10). Mongo becomes authoritative;
      `auth.json` is seed input for `update-auth.js` only.
- [ ] Fix `mongoDisabled` latching permanently (S13) — make it a timestamp with a 30s retry window
      rather than a boolean that never resets
- [ ] Keep a documented break-glass path (an admin-create CLI) for when Mongo is down, so a database
      outage does not mean nobody can administer the system

## 1.6 Secrets hygiene (S5)

- [x] `git rm --cached auth.json` and add it to `.gitignore`
- [x] Commit `auth.example.json` with placeholder hashes. Every entry carries an explicit `role` from
      `DEFAULT_ROLES`, so the file also documents the role vocabulary — and, since `update-auth.js`
      now rejects an unknown role name, a typo in a copy of this file fails loudly at sync time
      rather than producing a user whose role silently falls back. `compliance` ships with
      `"active": false` to show that the flag exists and is honoured.
- [x] **Rotate all four passwords.** Removing the file from the index does not remove it from
      history — anyone with a clone still has them.
      **Still outstanding: record the four rotated passwords in the password manager.** They exist
      only in the working-tree `auth.json` (mode 600, now untracked), which is one `rm` away from
      locking everyone out of an app whose Mongo store holds only hashes.
- [ ] Decide on history rewriting (`git filter-repo`). It rewrites shared history and needs a
      coordinated force-push, so treat it as a separate, planned operation with team buy-in — **not
      part of this phase**. Rotation is the real mitigation.
      Confirmed present in history: commit `8cd4fd7` still contains the pre-rotation `auth.json`.

## 1.7 Infrastructure hardening (S6, S7, S8, S11, S9)

- [x] `docker-compose.yml`: Mongo port `"3000:27017"` → `"127.0.0.1:3000:27017"` (S6). The server's
      own `2000:2000` was bound to loopback at the same time — nginx proxies `/api` over the internal
      network, so nothing off-host needed it, and publishing it was a second unproxied entry point.
- [ ] Enable Mongo auth: `MONGO_INITDB_ROOT_USERNAME` / `_PASSWORD`, create an app user with
      least privilege on `investigation-chart` only, update `MONGO_URI` in `.env` and compose (S6).
      **Still open, and the loopback bind does not replace it** — it narrows who can reach the port,
      but anyone on this host, including any other container, still gets unauthenticated access.
- [ ] `helmet()` as the first middleware (S11)
- [ ] `cors({origin: <allowlist>, credentials: true})` — the wildcard must go, and `credentials: true`
      is required for the session cookie to work at all (S8)
- [ ] `express-rate-limit` on `/api/auth/login`: 5 attempts per 15 min keyed on IP + username;
      a looser global limiter on `/api/*` (S7)
- [ ] Per-account lockout: `failedAttempts` + `lockedUntil` on the user document (defence against a
      distributed attacker who rotates IPs and defeats the IP-based limiter)
- [ ] Generic client-facing errors; full detail to server logs only. Never return `error.message`,
      EMR response bodies, or stack traces (S9)
- [ ] `server/Dockerfile`: `EXPOSE 6001` → `EXPOSE 2000` (cosmetic, but currently misleading)
- [ ] Update `.env.example` with every new key

## 1.8 Client updates

- [ ] `api/client.js`: `credentials: 'include'` on every request
- [ ] Replace the `sessionStorage` auth flag with a `GET /api/auth/me` call on mount (S3)
- [ ] Global 401 handler → clear state, return to login with "Your session expired"
- [ ] Wire the logout button to `POST /api/auth/logout` so the server session is actually destroyed
- [ ] Show a specific message for a locked account ("Locked for 15 minutes") vs bad credentials

## Phase 1 exit criteria

| Check | Expected |
|---|---|
| `curl -X POST localhost:2000/api/search` (no cookie) | **401** (was 200) |
| `curl localhost:2000/api/detail/123` (no cookie) | **401** |
| `curl localhost:2000/api/config/hospital` (no cookie) | **401** |
| `sessionStorage.setItem('investigation-auth','{}')` then reload | Still shows login screen |
| `regNo` = `4975109' OR 1=1--` | **400**, no EMR request made |
| Mongo `auth` documents | Contain `passwordHash`, no `password` field |
| `git ls-files \| grep auth.json` | No output |
| 6 failed logins in a row | 6th returns 429 or account-locked |
| `curl -sI localhost:2000/api/health` | Helmet headers present |
| `nmap`/`ss` from another host on port 3000 | Refused |
| All 4 users log in with **rotated** passwords, browser end-to-end | Pass |
| `npm run build --prefix client` and `npm test --prefix server` | Green |

---

# Phase 2 — RBAC foundation

**Goal:** roles and permissions enforced server-side; every data access audited.
**Effort:** 3–5 days · **Risk:** medium · **Depends on:** Phase 1
**Blocked by:** D5 (role list needs clinical/compliance sign-off)
**Fixes:** S17, and delivers the control surface catalogued in `UPGRADE.md` §7

## 2.1 Data model

- [x] `roles` collection — seed the 6 roles from `UPGRADE.md` §7.1 with the §7.3 default matrix
- [x] ~~`users` collection~~ — **deviation:** the existing `auth` collection gained `role`, `active`,
      `scope{}`, `overrides{}`, `failedAttempts`, `lockedUntil`, `lastLoginAt` instead of moving to a
      new collection. A second collection would have made the effective user list `auth ∪ users`,
      which is the same split-brain bug Phase 1 removed (B10). `mustChangePassword` is deferred to
      2.8, which is where the UI to act on it lives.
- [x] `audit_log` collection — indexed on `at`, `username`+`at`, `target.regNo`+`at`
- [x] Idempotent seed script (`scripts/seed-roles.js`) so re-running is safe
- [x] Migrate the 4 existing users: assign roles explicitly — **do not default anyone to `admin`**
      (they were `viewer`, not a real role; all four now hold a valid role and the script prints an
      ACTION REQUIRED list rather than guessing)

## 2.2 Permission resolution

- [x] `server/src/services/rbacService.js`
  - `resolveAccess(user)` returns permissions, limits, visibility and scope in one object, rather
    than four functions each re-reading the role document
  - `access.can(permission)` → boolean
  - Role documents cached in memory for 10s; `invalidateRoleCache()` for role writes
  - The role is read from the **user document** on every request, not from the session — this is
    what makes mid-session revocation effective without a re-login
- [x] `middleware/rbac.js` → `requirePermission(...perms)` (all-of) and `requireAnyPermission(...)`
      (any-of), returning 403 `{code:'FORBIDDEN'}`
- [x] **Every 403 is audited.** Repeated denials from one account are a genuine intrusion signal.

## 2.3 Apply gates to routes

- [x] `POST /api/search` → `requireAnyPermission('investigation:search', 'patient:lookup_only')`,
      with the lookup-only branch answering exists/does-not-exist and never a payload
- [x] `GET /api/detail/:orderid` → `requirePermission('investigation:view_detail')`
- [x] `GET /api/auth/me` → returns `{username, role, permissions[], limits{}, visibility{}}`; the
      client shapes itself from this and never hard-codes a role name. `sensitiveTestGroups` is
      deliberately withheld — it would enumerate the categories the user may not see.
- [ ] Admin routes (`/api/admin/users`, `/api/admin/roles`) behind `admin:*` permissions — the
      permissions exist; the routes are part of 2.8

## 2.4 Data scoping

- [x] `middleware/dataScope.js` — clamps the date span to the role's `maxRangeDays` server-side and
      reports the applied range in `scopeApplied`, so the narrowing is visible rather than silent
- [x] Ward/unit filtering on result rows (`allowedWards`, `allowedUnits`)
- [ ] Result-status filtering — hide unapproved/pending results from non-lab roles
- [x] `maxSearchesPerHour` per user (`middleware/searchQuota.js`, Mongo-backed hourly TTL buckets)
- [x] **Caveat handled:** a missing ward/unit column now fails **closed** — `applyRowScope` refuses
      the request rather than returning unfiltered rows. Still needs verification against real EMR
      data before anyone relies on ward scoping in production.

## 2.5 Field-level masking

- [x] `server/src/services/maskingService.js` — strips denied test groups and masks demographics
      before serialisation, never in React
- [x] Applied to both the chart payload and the raw-results payload
- [x] The deny-list matches category names **and** each field's `label`/`id`. Matching category names
      alone let an HIV row filed under `SEROLOGY` through — found by a failing test, not by review.
      A category emptied by row-level denial is dropped rather than left as a bare heading.

## 2.6 Audit logging

- [x] `server/src/services/auditService.js` — `LOGIN_SUCCESS`, `LOGIN_FAILED`, `LOGIN_LOCKED`,
      `LOGOUT`, `SEARCH`, `VIEW_DETAIL`, `PERMISSION_DENIED`, `AUDIT_READ`, `ADMIN_*`
- [x] Identifiers and outcomes only, enforced by an `ALLOWED_TARGET_FIELDS` whitelist that drops
      (and warns about) anything else, so a call site passing a whole EMR row cannot leak values
- [ ] Retention policy — **still open, needs compliance.** Deliberately no TTL index yet: silently
      expiring clinical audit data is worse than an oversized collection.
- [x] `GET /api/audit` behind `audit:read`, bounded paging, filters built field by field

## 2.7 Client: permission-aware UI

- [x] `usePermissions()` hook reading `/api/auth/me`, empty-by-default access
- [x] Conditionally render tabs and Print (Export is a Phase 4 feature; the permission exists)
- [x] Role badge in the header
- [x] Friendly 403 state instead of a bare error (`ForbiddenError` keeps the user where they are —
      signing in again would not help)
- [x] Idle lock driven by the role's `idleLockMinutes` (**not** `sessionTimeoutMinutes` — that is the
      absolute session lifetime, a different thing). Enforced in **two** places on purpose:
  - `attachAccess` (server) refuses and destroys any session idle past the role's limit, and audits
    it as `SESSION_EXPIRED`. This is the enforcement. `requireAuth` cannot do it — the role's limits
    are only known after `resolveAccess`, which needs the session `requireAuth` produced — so
    `requireAuth` hands the pre-touch idle age forward as `req.user.idleForMs`.
  - `useIdleLock` (client) signs the user out locally after the same interval, with a 60-second
    countdown first. This is not a security boundary; its job is getting patient data off an
    unattended screen, which the server cannot do. Deliberately **not** an overlay: an overlay
    leaves the results mounted behind it, so clearing the session and unmounting `Dashboard` is
    strictly stronger. `mousemove` is excluded from the activity list — a knocked desk should not
    keep results on screen indefinitely.

## 2.8 Admin screens

- [ ] User list: create, edit, disable, reset password, force logout
- [ ] Role editor: toggle permissions and limits without a redeploy
- [ ] "Sync from auth.json" button behind `admin:auth_sync`
- [ ] Prevent an admin from removing their **own** last admin permission (lockout footgun)

## Phase 2 exit criteria

| Check | Expected | Verified |
|---|---|---|
| `nurse` calls `/api/search` with a 90-day range (limit 30) | Clamped to 30 days, not rejected silently — response states the applied range | Unit-tested; end-to-end run used a 1-day range, so the clamp message has not been seen live |
| `front_desk` calls `/api/search` | Bare exists/does-not-exist, never a payload, audited | ✅ live: `{ok, lookupOnly, exists, regNo}` only |
| `lab_tech` requests a chart with `view_chart` disabled | 403 | Unit-tested (`rbac.test.js`) |
| `nurse` chart payload inspected in DevTools | Contains **no** HIV/genetics rows at all | Unit-tested, incl. an HIV row filed under `SEROLOGY` |
| Role permission revoked mid-session | Takes effect on the next request (no re-login needed) | By construction — the role is read from the user document per request |
| Every search/detail/login/denial | One `audit_log` document, zero lab values inside | ✅ live: `LOGIN_SUCCESS`, `SEARCH`, `AUDIT_READ`, `PERMISSION_DENIED` all present with identifiers only |
| Client with `permissions: []` forged in DevTools | Buttons appear, but every API call still 403s | By construction — the client never gates the server |
| Unit tests for `rbacService` and `dataScope` | Green | ✅ 51/51 across `auth.test.js`, `rbac.test.js`, `validate.test.js` |
| Session idle past a role's `idleLockMinutes` but inside the global 30-min ceiling | 401 `SESSION_IDLE`, session row deleted, audited | ✅ tested against `front_desk` (5 min), with an assertion that the role limit is stricter than the global one so the test cannot pass for the wrong reason |

**Deviation from the plan, deliberate:** `front_desk` gets a lookup answer rather than a flat 403.
The row in the original table said 403, but `patient:lookup_only` exists precisely so reception can
confirm "we have results for this patient" without seeing any. A 403 would make the permission
unusable. The important half of the guarantee — no result data reaches them — holds and is tested.

**Not done in Phase 2:** 2.8 admin screens, result-status filtering, and the audit retention window
(needs compliance). Ward scoping is implemented and fails closed but has not been exercised against
real EMR ward data.

**Fixed while finishing 2.7:** `scripts/update-auth.js` was writing `role` on every run, defaulting
to `'viewer'` — a role that does not exist in the Phase 2 matrix. Rotating one password would have
silently reset every user's role to an unmapped value, which `resolveAccess` then replaces with
`FALLBACK_ROLE`. Every deliberate role assignment would have been undone by the next credential sync.
The script now treats `role` and `active` as authorisation, not credentials: it writes them only when
`auth.json` states them explicitly (validated against `DEFAULT_ROLES`, and logged when they change)
or when creating a new user, where it defaults to `FALLBACK_ROLE`.

---

# Phase 3 — Backend hardening & performance

**Goal:** `emrService.js` split into testable pieces; search materially faster; failures diagnosable.
**Effort:** 3–5 days · **Risk:** medium-high (touches the chart algorithm, the app's core value)
**Depends on:** Phase 1 only — **can run in parallel with Phase 2**
**Fixes:** B1, B2, B3, B4, B5, B6, B8, B11, B12, S10

> Highest-regression-risk phase in the plan. The chart-assembly logic encodes a lot of hard-won
> EMR-specific behaviour (repeat-test handling, department-vs-category disambiguation, alias
> matching). **Write characterisation tests before refactoring**, not after.

## 3.1 Safety net first

- [ ] Capture real EMR responses as fixtures (anonymised UHIDs and patient names)
- [ ] Characterisation tests: feed fixtures to the current `buildInvestigationChart`, snapshot the
      output, assert the refactor reproduces it **byte for byte**
- [ ] Cover the tricky paths explicitly: same-day repeat tests (`__rep2` suffixing and insertion
      position), `isDepartmentName` filtering, the 3-permutation regNo/IPNo fallback, alias
      normalisation in `normalizeTestKey`

## 3.2 Split `emrService.js` (584 lines → 4 modules) (B1)

- [ ] `services/emrClient.js` — login, session, HTTP, retry. No parsing.
- [ ] `services/emrQueries.js` — query construction, isolated so the eventual parameterised endpoint
      (D7) is a one-file change
- [ ] `services/chartBuilder.js` — **pure function**: rows in, chart out. No network. Fully unit-testable.
- [ ] `services/labDetailService.js` — order detail + parsing
- [ ] Keep the public surface (`searchInvestigation`, `getLabDetail`) unchanged so routes need no edits

## 3.3 Performance (B2)

- [ ] **One EMR session per request** — hoist `createClient()` + `doLogin()` out of the per-order
      loop. Currently 12 orders = 12 logins. Roughly halves round-trips on its own.
- [ ] **Bounded concurrency** for order-HTML fetches: 4–6 workers, configurable via env.
      **Start low.** The EMR is a shared production system; hammering it is not acceptable.
      Measure against the Phase 0 baseline before raising the cap.
- [ ] Per-order failures must degrade gracefully into the existing `fetchErrors` array, never fail
      the whole search
- [ ] Timeout + single retry with backoff on EMR calls

## 3.4 Caching (B4, B3)

- [ ] `services/cacheService.js` — Mongo `chart_cache`, key `regNo|from|to`, TTL index, default 10 min
- [ ] **Cache the unmasked payload; apply masking after retrieval.** Otherwise a nurse's redacted
      chart could be served to a doctor. This ordering is not optional once Phase 2 lands.
- [ ] Add a TTL to `dynamicTestGroups` (currently a module variable that never invalidates, so new
      EMR tests never appear until a restart) (B3)
- [ ] `POST /api/cache/invalidate` behind `cache:invalidate`
- [ ] Surface "Showing cached result from HH:MM · Refresh" in the UI — never let a clinician
      unknowingly read stale labs

## 3.5 Observability (B5, B8)

- [ ] Request ID middleware (`crypto.randomUUID()`), echoed in the `X-Request-Id` response header
- [ ] Structured JSON logs: `{ts, level, requestId, userId, route, ms, outcome}` — **no PHI**
- [ ] Timing around each EMR call, so "search is slow" becomes answerable after the fact
- [ ] Real `/api/health`: ping Mongo, optionally probe EMR reachability, report degraded states.
      Today it returns `{ok:true}` unconditionally — a fully broken app reports healthy (B8).
- [ ] Slow-search warning log above a threshold

## 3.6 Robustness (B12, B11)

- [ ] Graceful shutdown: `SIGTERM`/`SIGINT` → stop accepting, drain in-flight, close Mongo
- [ ] `unhandledRejection` / `uncaughtException` handlers that log before exiting
- [ ] Remove the 5-path static-file probing from `index.js` — nginx serves the UI in every real
      deployment; the fallback is misleading dead complexity (B11)
- [ ] Mongo connection pool sizing and a sane `serverSelectionTimeoutMS`

## 3.7 Per-user EMR credentials (S10) — investigate

- [ ] Determine whether the EMR supports per-user auth. Today every request uses one shared service
      account, so **the EMR's own audit trail cannot attribute any access to a real person.**
      Our `audit_log` fixes attribution on our side; it cannot fix theirs.
- [ ] If unsupported, document the gap explicitly as an accepted risk with compliance sign-off

## 3.8 Test suite (B6)

- [ ] Delete or convert the ad-hoc `test_*.js` scripts
- [ ] Unit: `chartBuilder`, `dateUtils`, `htmlParser`, `rbacService`, `validate`, `authService`
- [ ] Integration: full auth flow, RBAC denials, validation rejections (mock the EMR)
- [ ] `npm test` runs everything via `node --test`; wire into CI if one exists

## Phase 3 exit criteria

| Check | Expected |
|---|---|
| Characterisation tests before vs after refactor | Byte-identical chart output |
| EMR logins per search | 1 (was N) |
| Search latency vs Phase 0 baseline | Measurably faster; number recorded |
| Second identical search | Cache hit, sub-100ms |
| Cached chart served to a differently-scoped role | Correctly re-masked for that role |
| Mongo stopped | `/api/health` reports degraded, not `{ok:true}` |
| `docker compose stop server` mid-search | Clean drain, no truncated response |
| `npm test --prefix server` | Green, `chartBuilder` covered |
| Any log line | Contains a requestId, contains no PHI |

---

# Phase 4 — UX & design

**Goal:** faster daily loop, readable dense chart, accessible, usable on a tablet.
**Effort:** 4–6 days · **Risk:** low (mostly additive UI)
**Depends on:** Phase 2 for permission-shaped UI · Phase 3's cache makes 4.2 feel instant
**Fixes:** U1–U15, S15

## 4.1 Search loop (U1, U2, U6, U5)

- [ ] **Default `fromDate` to 7 days ago instead of today.** One line in `App.jsx`; eliminates the
      most common "No records found" dead end. Ship this first — it is the highest
      value-to-effort item in the whole plan.
- [ ] Preset range chips: Today · 7d · 30d · This admission
- [ ] Recent searches in `sessionStorage`, rendered as clickable chips
- [ ] Encode search state in the URL (`?reg=&from=&to=`) and read it on mount — refresh-safe and
      shareable, no router needed
- [ ] `autoFocus` the UHID field; `/` as a focus shortcut

## 4.2 Feedback & errors (U3, U7, U13)

- [ ] Chart-shaped skeleton loaders instead of one centred spinner
- [ ] Staged progress ("Fetching 4 of 12 orders…") — the long wait currently looks like a hang
- [ ] Friendly error mapping in `api/client.js`: status + known EMR failures → plain sentences;
      raw detail to console only
- [ ] Distinguish "no results in this range" from "search failed" — today both look like failure
- [ ] `aria-live` announcements when a search completes

## 4.3 Chart readability (U8, U9)

- [ ] Sticky Parameter + Ref. Range columns (`position: sticky`)
- [ ] Sticky date header row
- [ ] Zebra striping and row hover highlight
- [ ] **Abnormal cells get ↑/↓ glyphs and bold weight in addition to colour.** Colour-only fails
      colour-blind users and prints uselessly in mono (WCAG 1.4.1).
- [ ] "Abnormal only" toggle — turns a 60-row chart into the 6 rows that matter on rounds
- [ ] Row filter / test search box
- [ ] Compact / comfortable density toggle
- [ ] Collapsible sections that remember their state
- [ ] Click a row → mini trend view for that test across the admission
- [ ] Optional inline sparkline per row

## 4.4 Export (U12)

- [ ] CSV export behind `investigation:export_csv`
- [ ] Respect `maxExportRows`; audit every export with row count
- [ ] Export the **masked** payload — never the raw one

## 4.5 Layout & responsive (U14)

- [ ] App shell: slim top bar with logo, app name, user + role badge, session timer, logout
- [ ] Search bar collapses to a one-line summary after a search, reclaiming vertical space
- [ ] Below 900px: fields stack, sticky columns carry the chart, patient strip becomes 2-column
- [ ] Test on a real tablet — ward rounds happen on tablets, not desks
- [ ] Toasts for transient outcomes; keep the inline block for real errors

## 4.6 CSS restructure

- [ ] Extend `:root` with spacing/radius/type/shadow tokens (keep existing colours untouched)
- [ ] Split the 957-line `App.css` into `tokens.css`, `base.css`, `components.css`, `chart.css`,
      `print.css`, imported from one `index.css`. Same output, navigable source.
- [ ] Verify the split produces visually identical output before deleting the original

## 4.7 Accessibility (U9, S15)

- [ ] `aria-label` on every icon-only control (`req-badge` in `RawResults` has `role="button"` and
      `tabIndex` but no accessible name)
- [ ] Focus trap + `aria-modal="true"` on `DetailModal` (Escape works; focus management does not)
- [ ] `<caption>` and `scope` attributes on chart tables
- [ ] Verify 4.5:1 contrast on `--muted` `#64748b` over `#f8fafc`
- [ ] Skip-to-content link; full keyboard-only pass
- [ ] Sanitise the hospital-address HTML or render it as structured fields instead of
      `dangerouslySetInnerHTML` (S15 — config-sourced, so low risk, but avoidable)

## 4.8 Login screen polish

- [ ] Caps-lock warning
- [ ] Inline validation before submit
- [ ] Hospital logo in place of the 🔐 emoji
- [ ] Distinct messages for locked account vs bad credentials
- [ ] Keep the eye toggle's existing a11y (`aria-pressed`, swapped `aria-label`, `:focus-visible`)

## Phase 4 exit criteria

| Check | Expected |
|---|---|
| Fresh load, search an admitted patient with no date edits | Returns results (7-day default) |
| Chart scrolled right 20 columns | Parameter name still visible |
| Abnormal values in greyscale print | Distinguishable without colour |
| Full keyboard-only pass, login → search → detail → print | No trap, visible focus throughout |
| 768px viewport | Usable without horizontal page scroll |
| URL copied to another browser after login | Same search restored |
| Lighthouse a11y | ≥ 90 |
| `npm run build --prefix client` | Green, bundle size noted |

---

# Phase 5 — Operational maturity

**Goal:** TLS, reliable PDF, audit visibility, cleanup.
**Effort:** ongoing · **Risk:** low-medium (TLS touches deployment)
**Fixes:** S12, S16, U11, B9

## 5.1 TLS (S12)

- [ ] TLS termination at nginx; HTTP → HTTPS redirect
- [ ] HSTS, CSP, `X-Frame-Options: DENY`, `nosniff`
- [ ] Flip session cookies to `secure: true` in production
- [ ] Certificate renewal automation
- [ ] **Until this ships, credentials cross the wire in cleartext.** On a trusted hospital LAN that
      is a lower risk than Phase 1's issues, which is why it sits here — but it is not zero risk.

## 5.2 Server-rendered PDF (U11)

- [ ] `POST /api/export/pdf` behind `investigation:export_pdf`
- [ ] Per-role watermark: "CONFIDENTIAL — <username> — <timestamp>"
- [ ] Remove the duplicated print DOM from `InvestigationChart.jsx` (the chart currently renders
      twice on every view); keep `window.print()` as a fallback
- [ ] Optional `printRequiresReason` prompt, recorded in the audit log

## 5.3 Audit dashboard

- [ ] `auditor` role view: filter by user, patient, action, date
- [ ] Anomaly surfacing: unusual search volume, repeated denials, off-hours access
- [ ] CSV export behind `audit:export`

## 5.4 Settings UI

- [ ] Hospital letterhead editable via `admin:settings_write` (currently env-only)
- [ ] Chart template / alias editor — `chartTemplate.js` currently needs a redeploy to change
- [ ] Cache TTL and EMR concurrency tunable at runtime

## 5.5 Cleanup & docs (S16, B9)

- [ ] Delete `server.zip`, `client/dist.zip`, `dummy.json`; decide on `investigation.php`
      (keep as reference *outside* the repo, or drop it)
- [ ] Rewrite the README: correct ports, RBAC roles, setup, troubleshooting
- [ ] Document every `.env` key in `.env.example`
- [ ] Add ESLint + Prettier using the project's existing style as the baseline
- [ ] Backup/restore runbook for Mongo (users, roles, audit log)

---

# Rollback plan

Each phase must be revertable without data loss.

| Phase | Rollback | Data risk |
|---|---|---|
| 1 | `git revert` the phase commits; restore the Phase 0 Mongo dump | **Password hashing is one-way.** Rolling back after rotation means re-issuing passwords from the dump's plaintext, or re-rotating. Keep the Phase 0 dump until Phase 1 is confirmed stable. |
| 2 | Revert; `users`/`roles`/`sessions` collections can be dropped | Audit log should be **preserved**, not dropped — it may be needed for compliance even if the feature is rolled back |
| 3 | Revert; drop `chart_cache` | None — cache is derived data |
| 4 | Revert; client-only | None |
| 5 | Revert nginx config; keep TLS certs | None |

Before merging any phase to `main`: tag the pre-merge commit so `git reset --hard <tag>` is a
one-liner if production misbehaves. (That reset is destructive — coordinate it, do not run it
casually.)

---

# Effort summary

| Phase | Scope | Effort | Blocking? |
|---|---|---|---|
| 0 | Preparation | ~1 hour | — |
| 1 | Critical security | 1–2 days | **YES — do first** |
| 2 | RBAC foundation | 3–5 days | Blocked by D5 |
| 3 | Backend hardening & perf | 3–5 days | Parallel with 2 |
| 4 | UX & design | 4–6 days | Needs 2 |
| 5 | Operational maturity | ongoing | — |

**Total: roughly 12–19 working days** for one developer familiar with this codebase, excluding
review, stakeholder decisions (D1–D7), and deployment windows.

If time is tight, the defensible minimum is **Phase 0 + Phase 1 + items 4.1 and 4.3** (~3 days):
the app stops leaking PHI, the injection is closed, passwords are hashed, and the two changes users
notice most (7-day date default, sticky chart columns) land.

---

# Quick wins — under an hour each

Individually shippable, no phase dependency. Ordered by value.

1. [ ] `regNo` regex validation — closes the injection vector at the edge (S2)
2. [ ] `helmet()` — one line, baseline security headers (S11)
3. [ ] Rate-limit the login route — kills brute force (S7)
4. [ ] Replace `error.message` in responses with generic text (S9)
5. [ ] Default `fromDate` to 7 days ago — removes the most common empty result (U1)
6. [ ] Sticky first two chart columns — pure CSS (U8)
7. [ ] ↑/↓ abnormal markers at `getStatusColor`'s call site (U9)
8. [ ] Bind Mongo to `127.0.0.1` in compose (S6)
9. [ ] `git rm --cached auth.json` + `.gitignore` (S5 — then rotate)
10. [ ] Fix README ports; `EXPOSE 6001` → `2000` (B9)
11. [ ] Delete `server.zip`, `client/dist.zip`, `dummy.json` (S16)

---

# Open questions for you

1. **D5** — do the 6 roles in `UPGRADE.md` §7.1 match how your staff actually work? Which test
   groups count as sensitive? I cannot decide this; it needs clinical and compliance input.
2. **D7** — can the EMR team expose a parameterised query endpoint instead of `strQuery`? This has a
   long lead time, so ask now even though the mitigation lands in Phase 1.
3. Are ward/unit columns reliably populated in your EMR data? Phase 2's ward scoping depends on it,
   and an empty value must fail closed.
4. What audit retention window does compliance require?
5. Is there a staging environment, or does this go straight to the machine users are on?
6. Who owns the Mongo credentials and the TLS certificates once auth is enabled?

---

# Status log

| Date | Phase | Note |
|---|---|---|
| 2026-08-26 | — | `upgrade` branch created from `main` @ `f826679`; `UPGRADE.md` audit and this plan written. No implementation started. |
| 2026-08-26 | 0 | Phase 0 complete. Baseline latency captured (915 rows / 22 dates = **80.6s**, 70 rows / 2 dates = 23.7s, empty = 4.7s). Mongo `auth` backed up via new `scripts/backup-auth.js` (`mongodump` unavailable) and round trip verified byte-identical into a scratch db. `npm test` wired up; `test_auth.js` → `auth.test.js` so `node --test` discovers it; six live-EMR probes moved to `server/manual/` with a README. README ports fixed to 1000/2000/3000. `server.zip`, `client/dist.zip`, `dummy.json` untracked and gitignored. Client build green. Docker access still unavailable from this shell (0.8 open). |


