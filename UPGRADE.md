# Investigation Chart — Full Analysis & Upgrade Plan

> Audit date: 2026-08-26. Scope: whole repo (`client/`, `server/`, `scripts/`, `docker-compose.yml`).
> Every "current state" claim below was read from source or verified with a live request; the
> **Verification log** at the end separates what I confirmed from what I inferred.

The guiding constraint for every proposal here: **this stays a simple investigation-chart tool.**
Nothing below asks you to adopt a framework rewrite, a microservice split, or a design system.
The recommendations are ordered so you can stop after Phase 1 and still have a materially safer,
friendlier app.

---

## 1. Current architecture (as-is)

### 1.1 Topology

| Layer | Tech | Container | Host port | Notes |
|---|---|---|---|---|
| UI | React 18.3.1 + Vite 6.4, plain CSS | `patient-investigation-client` | `1000` → `80` | nginx serves static `dist`, proxies `/api` |
| API | Node 22 + Express 4.21 | `patient-investigation-server` | `2000` → `2000` | also has a static-serve fallback for `client/dist` |
| Store | MongoDB 7 | `patient-investigation-mongo` | `3000` → `27017` | **only** used for the `auth` collection |
| Upstream | External EMR (`emr.mapims.edu.in`) | — | — | SOAP/ASMX endpoints, screen-scraped |

There is no application database for clinical data. Every search hits the live EMR. Mongo holds
nothing but usernames and passwords.

### 1.2 Source map

```
client/src/
  App.jsx                    181 lines — ALL app state (auth, search, tabs, modal)
  api/client.js               48 lines — 4 fetch wrappers, no interceptor/error normalisation
  components/
    LoginScreen.jsx          122 — username + password (+ new eye toggle)
    SearchForm.jsx            54 — UHID/IP, from date, to date, Search, Print
    InvestigationChart.jsx   265 — renders chart TWICE (screen view + print view)
    RawResults.jsx            92 — dynamic table from arbitrary EMR columns
    DetailModal.jsx           88 — per-order drill-down
  styles/App.css             957 — single global stylesheet, no variables beyond :root colours

server/src/
  index.js                   120 — 5 routes, createApp() factory, static+SPA fallback
  config.js                   33 — env → config object
  services/authService.js    116 — Mongo-then-auth.json credential check
  services/emrService.js     584 — EMR login, raw-SQL query, HTML scrape, chart assembly
  templates/chartTemplate.js 161 — test-name aliases → canonical chart rows
  utils/htmlParser.js         59 — cheerio table extraction
  utils/dateUtils.js          52 — date parse/normalise/sort
  test_*.js (7 files)         ~140 total — ad-hoc scripts, only test_auth.js is a real node:test

scripts/update-auth.js        94 — syncs auth.json → Mongo (upsert + prune)
auth.json                     19 — 4 users, PLAINTEXT passwords, TRACKED IN GIT
```

### 1.3 Dependency reality check

Installed and used: `express`, `cors`, `dotenv`, `axios`, `axios-cookiejar-support`,
`tough-cookie`, `cheerio`, `mongodb`, `react`, `react-dom`, `vite`, `@vitejs/plugin-react`,
`concurrently`.

**Absent** (verified — not in `server/node_modules`): `jsonwebtoken`, `bcrypt`, `bcryptjs`,
`helmet`, `express-rate-limit`, `cookie-parser`. There is no router, no state library, no
component library, no test runner config, no linter, no formatter.

Note: `server/.env` already defines `JWT_SECRET` and `JWT_EXPIRES_IN`, but `grep` finds **zero**
references to `jwt` or `token` anywhere in `server/src` or `client/src`. The intent to issue
tokens exists in config but was never implemented.


---

## 2. Current end-to-end flow (as-is)

```
┌─ Browser ─────────────────────────────────────────────────────────────────┐
│                                                                            │
│  1. GET /            nginx :1000 → index.html + JS/CSS bundle              │
│  2. App.jsx mounts                                                         │
│     └─ GET /api/config/hospital ..................... NO AUTH REQUIRED     │
│     └─ isAuthenticated = Boolean(sessionStorage['investigation-auth'])     │
│                                                                            │
│  3. if !isAuthenticated → <LoginScreen>                                    │
│     └─ POST /api/login {username, password}                                │
│         server: validateCredentials(u, p)                                  │
│           ├─ Mongo `investigation-chart.auth`.findOne({username})          │
│           │    → user.password === password   (PLAINTEXT ===)              │
│           │    → if Mongo unreachable: mongoDisabled = true FOREVER        │
│           └─ fallback: read auth.json at request time, .some(match)        │
│         ← 200 {ok:true, username}   /   401 {ok:false, error}              │
│     └─ client: sessionStorage.setItem('investigation-auth', {username})    │
│        ***NO TOKEN, NO COOKIE, NO SERVER-SIDE SESSION***                   │
│                                                                            │
│  4. <SearchForm> → POST /api/search {regNo, fromDate+T00:00, toDate+T23:59}│
│                                     ......... NO AUTH REQUIRED (verified)  │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
┌─ server/src/services/emrService.js ────────────────────────────────────────┐
│  searchInvestigation(regNo, from, to)                                      │
│   ├─ normalizeSearchDate() → "MM/DD/YYYY HH:mm"                            │
│   ├─ fetchSearchResults() — tries up to 3 permutations:                    │
│   │    input has "IP"?  → @IPNO raw → @IPNO stripped → @RegNo              │
│   │    else            → @RegNo → @IPNO → @IPNO with "IP" prefix           │
│   │    each attempt = queryEMR() = POST wsQueryBuilder.asmx/Getdataset1    │
│   │      body: { strQuery: "<RAW T-SQL, regNo INTERPOLATED>",              │
│   │              strCon: "BB_CONSTR" }                                     │
│   └─ buildInvestigationChart(rows)                                         │
│        ├─ fetchDynamicTestGroups() — ANOTHER raw T-SQL recursive CTE       │
│        │    (cached in module-level `dynamicTestGroups`, never invalidated)│
│        ├─ for EACH order row (N sequential round-trips):                   │
│        │    ├─ createClient() — new CookieJar per order                    │
│        │    ├─ doLogin() — EMR_USERNAME/EMR_PASSWORD shared service acct   │
│        │    ├─ fetchLabResultHtml(orderId) — GET LabResultHis.aspx         │
│        │    ├─ cheerio: extractResultTable → parseResultTableToArray       │
│        │    └─ normalizeTestKey() → chartTemplate alias match              │
│        └─ returns {chartDates, chartValues, template, patientMeta,         │
│                    fetchErrors, unmapped}                                  │
└────────────────────────────────────────────────────────────────────────────┘
                                    │
┌─ Browser render ───────────────────────────────────────────────────────────┐
│  tabs: 📋 Investigation Chart  |  📄 Raw Results                           │
│   chart → InvestigationChart: screen table + SEPARATE print DOM            │
│           (print chunks dates 5-per-page, letterhead repeated per page)    │
│   raw   → RawResults: every EMR column as-is; Req No cell → req-badge      │
│           click → DetailModal → GET /api/detail/:orderid  .... NO AUTH     │
│  Print  → window.print(), CSS @media print swaps the two views            │
└────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 The critical structural fact

**Authentication is decorative.** `POST /api/login` returns a plain JSON body and the client
records success in `sessionStorage`. No token is minted, nothing is attached to later requests,
and no route except `/api/login` inspects credentials at all.

I verified this directly against the running server:

```
$ curl -s -o /dev/null -w '%{http_code}' -X POST localhost:2999/api/search \
    -H 'Content-Type: application/json' \
    -d '{"regNo":"4975109","fromDate":"2025-01-01T00:00","toDate":"2025-01-31T23:59"}'
200

$ curl -s -o /dev/null -w '%{http_code}' localhost:2999/api/config/hospital
200
```

Anyone who can reach port 2000 (or 1000) can pull patient lab results by UHID without ever
seeing the login screen. Typing `sessionStorage.setItem('investigation-auth','{}')` in the
browser console also bypasses the UI gate completely. **This is the single most important
finding in this document.**

---

## 3. Findings — Security

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

| # | Sev | Finding | Location |
|---|---|---|---|
| S1 | **C** | No authorisation on any data route. PHI readable unauthenticated. | `index.js:63,81,59` |
| S2 | **C** | SQL injection into EMR query builder via `regNo`. | `emrService.js:54-70` |
| S3 | **C** | Auth state is a client-side boolean; trivially forged. | `App.jsx:24-26,46` |
| S4 | **H** | Passwords stored plaintext in `auth.json` **and** Mongo. | `auth.json`, `update-auth.js:58` |
| S5 | **H** | `auth.json` with real passwords is committed to git. | `git ls-files` |
| S6 | **H** | Mongo published on `0.0.0.0:3000` with **no authentication**. | `docker-compose.yml:6` |
| S7 | **H** | No rate limiting → unlimited password guessing on `/api/login`. | `index.js:37` |
| S8 | **M** | `cors()` with no options = `Access-Control-Allow-Origin: *`. | `index.js:27` |
| S9 | **M** | Internal error text returned to client (`error.message`, EMR raw body). | `index.js:55,77,95` |
| S10 | **M** | Shared EMR service account for all users → no per-user audit trail. | `config.js:23-24` |
| S11 | **M** | No `helmet`; no CSP, HSTS, X-Frame-Options, nosniff. | `index.js` |
| S12 | **M** | No HTTPS anywhere; credentials cross the wire in cleartext. | `nginx.conf`, compose |
| S13 | **M** | `mongoDisabled` latches permanently — one blip disables Mongo till restart. | `authService.js:23,38` |
| S14 | **L** | Password compared with `===` (timing-observable). | `authService.js:64,95` |
| S15 | **L** | `dangerouslySetInnerHTML` for hospital address (config-sourced). | `InvestigationChart.jsx:184,231` |
| S16 | **L** | Stale artifacts tracked: `server.zip`, `client/dist.zip`, `investigation.php`, `dummy.json`. | repo root |
| S17 | **L** | No audit log of who searched which patient. | — |

### S2 in detail — the injection

`queryEMR` builds a T-SQL string and posts it to the EMR's generic query executor:

```javascript
const sql = `Use KMCH_Lab EXEC LabTestResultHistoryQB
        @FromDate = '${fromDate}',
        @ToDate = '${toDate}',
        @RegNo = '${regNoVal || ''}',      // ← user input, single-quoted, unescaped
        ...`;
await axios.post(config.emr.queryBuilderUrl, { strQuery: sql, strCon: 'BB_CONSTR' });
```

`/api/search` only checks `regNo?.trim()` is non-empty. A `regNo` containing a single quote
terminates the literal and the remainder is executed by the EMR under whatever privileges
`BB_CONSTR` carries. Compare with `/api/detail/:orderid`, which *does* validate (`/^\d+$/`) —
the pattern is already in the codebase, just not applied here.

Two independent fixes are needed, and both should be done:
1. **Validate at the edge** — `regNo` must match `/^(IP)?\d{1,15}$/i`, dates must be real dates.
2. **Stop sending raw SQL.** The `strQuery` design means the app is one bad input away from
   arbitrary database execution. Ask the EMR team for a parameterised endpoint that takes
   `RegNo`/`IPNo`/dates as fields. Until that exists, treat edge validation as a mitigation, not
   a fix, and whitelist rather than blacklist.

### S4/S5 in detail — password handling

`auth.json` is the source of truth, `update-auth.js` upserts it into Mongo verbatim, and
`authService.js` compares with `===`. Passwords are plaintext at all three points, and
`auth.json` is tracked by git — so they are in the repository history and on every clone.

Fixing this is a four-part job that must land together:
- `auth.json` becomes `{username, passwordHash, role, ...}` with bcrypt (cost 12), or is retired
  entirely in favour of Mongo-as-truth with an admin UI.
- `update-auth.js` hashes on write and never logs the plaintext.
- `authService.js` switches to `bcrypt.compare()`.
- `auth.json` gets `git rm --cached` + `.gitignore` entry, and **every password in it must be
  rotated**, because removing a file from the index does not remove it from history.

---

## 4. Findings — User experience

The app does its job, but nearly all friction is concentrated in the search-to-result loop that
users repeat all day.

| # | Issue | Why it matters |
|---|---|---|
| U1 | Both dates default to **today**, so the first search of any admitted patient returns nothing. | Guarantees a wasted round-trip on the most common case. |
| U2 | No date presets (Last 7 days / This admission / Last 30 days). | Manual two-field date entry, every single search. |
| U3 | Search is fully blocking: one spinner, "Please wait for a moment...", no progress. | `buildInvestigationChart` makes N sequential EMR round-trips; long waits look like a hang. |
| U4 | No result caching. Re-searching the same patient re-scrapes everything. | Slow, and pointless load on the EMR. |
| U5 | Search state lives only in React memory — refresh loses everything; no shareable URL. | Cannot bookmark or send a colleague "this patient, these dates". |
| U6 | No recent-searches list. | Nurses/doctors re-check the same few patients repeatedly. |
| U7 | Raw errors surface verbatim (`Search failed: {error.message}`). | Users see internals instead of "No results for this patient in this date range". |
| U8 | Chart is a fixed grid: no sticky parameter column, no row filter, no abnormal-only toggle, no per-test trend. | Wide admissions force horizontal scrolling with no anchor. |
| U9 | Abnormal values are colour-only (red/orange/green). | Fails colour-blind users and prints poorly in mono. WCAG 1.4.1. |
| U10 | Session never expires and has no idle lock, but also never survives a refresh. | Worst of both: unsafe on shared ward terminals, annoying for real work. |
| U11 | Print goes through `window.print()` and a duplicated print DOM. | No server-rendered PDF, inconsistent output, chart rendered twice. |
| U12 | No export to Excel/CSV. | Clinicians routinely want the grid in a spreadsheet. |
| U13 | No loading skeletons, no keyboard shortcut to focus search, tab order untested. | Small frictions, all day, every day. |
| U14 | 957-line global `App.css`, no responsive audit; cramped on a tablet at the bedside. | Ward rounds happen on tablets. |
| U15 | `RawResults` renders whatever columns the EMR returns, unlabelled and unsorted. | Column meaning varies; no sort, filter, or column chooser. |

### 4.1 Highest-value UX fixes (cheap, immediate)

1. **Default the date range to the last 7 days, not today.** One-line change in `App.jsx`; kills
   the most common "no records found" dead end (U1).
2. **Add preset range chips** — Today / 7d / 30d / This admission (U2).
3. **Friendly error mapping** in `api/client.js` — translate HTTP status + known EMR failures into
   plain sentences, log the raw text to console only (U7).
4. **Sticky first two columns** (`position: sticky` on Parameter + Ref. Range) so scrolling wide
   date ranges keeps the test name visible (U8).
5. **Abnormal markers, not just colour** — append `↑`/`↓` and a `title` tooltip alongside the
   existing colour, and add a bold border in print CSS (U9).
6. **"Abnormal only" toggle** above the chart — during rounds this is what people actually scan
   for (U8).
7. **Recent searches** in `sessionStorage`, rendered as clickable chips under the search bar (U6).
8. **Reflect search in the URL** (`?reg=...&from=...&to=...`) and read it on mount — makes results
   refresh-safe and shareable without adding a router (U5).

---

## 5. Findings — Backend & code structure

| # | Issue | Detail |
|---|---|---|
| B1 | `emrService.js` is 584 lines mixing EMR auth, SQL, scraping, and chart assembly. | Untestable as a unit; the chart algorithm is the app's real value and it is buried. |
| B2 | N+1 sequential EMR calls, one fresh login + `CookieJar` per order. | Dominates response time. Needs a shared session and bounded concurrency. |
| B3 | `dynamicTestGroups` cached in a module variable with no TTL or invalidation. | New tests in the EMR never appear until a restart. |
| B4 | No caching layer at all, despite Mongo being right there and mostly idle. | Obvious win: cache assembled charts keyed by `regNo+from+to`. |
| B5 | No structured logging, no request IDs, no timing metrics. | A slow search cannot be diagnosed after the fact. |
| B6 | Seven `test_*.js` ad-hoc scripts; only `test_auth.js` uses `node:test`, and it asserts almost nothing. | No regression safety net around the chart logic. |
| B7 | No input validation layer; each route hand-rolls its checks inconsistently. | S2 exists precisely because of this. |
| B8 | `/api/health` returns `{ok:true}` unconditionally — never checks Mongo or EMR. | A broken app still reports healthy. |
| B9 | Config drift: `config.js` defaults `PORT=6001`, `.env.example` says `6001`, compose says `2000`, README says `8080`/`3001`. | README is actively wrong; onboarding trap. |
| B10 | `authService`'s "Mongo says no → also try auth.json" makes the two stores' *union* authoritative. | A user removed from Mongo still logs in via the file. Deletion is not deletion. |
| B11 | Static-file serving in `index.js` probes 5 candidate paths at import time. | Dead complexity in the container (nginx serves the UI); harmless but misleading. |
| B12 | No graceful shutdown, no `unhandledRejection` handler. | Container restarts drop in-flight requests. |

### B10 is a security bug too

```javascript
if (mongoResult === false) {
  // User not found (or wrong password) in Mongo — still allow auth.json
  return checkAuthJson(username, password);
}
```

This was a deliberate belt-and-braces choice while debugging login, and it did its job. But it
means the effective user list is `Mongo ∪ auth.json`. Once RBAC exists, **one store must be
authoritative** — otherwise revoking access requires remembering to edit two places, and the
weaker one wins. Recommendation: Mongo is truth; `auth.json` becomes seed-only, used by
`update-auth.js` on first run and never consulted at login time.

### B2 in detail — why search feels slow

For a patient with 12 lab orders, `buildInvestigationChart` currently performs 12 iterations of
{new cookie jar → EMR login → fetch HTML → parse}. That is 12 logins and 24 sequential HTTP
round-trips to the EMR before the first byte reaches the user.

Fix in two steps, no new dependencies needed:
1. **One EMR session for the whole request.** Hoist `createClient()` + `doLogin()` out of the loop.
   Cuts the round-trips roughly in half immediately.
2. **Bounded parallelism.** Fetch order HTML with a small worker pool (4–6 concurrent) instead of
   serially. Keep the cap low and configurable — the EMR is a shared production system and
   hammering it is not acceptable. Measure before raising it.

Combined with the Mongo chart cache (B4), repeat views of the same admission become instant.

---

## 6. Target architecture (to-be)

Deliberately still two containers plus Mongo. The changes are additive middleware and a few new
collections, not a re-platform.

```
┌──────────── Browser ────────────┐
│  React SPA                      │
│   • httpOnly cookie session     │  ← no token in JS, so XSS cannot exfiltrate it
│   • RBAC-aware UI (hide/disable)│
│   • URL-encoded search state    │
└──────────────┬──────────────────┘
               │ HTTPS
┌──────────────▼─────────────────────────────────────────────────┐
│ nginx  — TLS termination, HSTS/CSP, /api proxy, gzip           │
└──────────────┬─────────────────────────────────────────────────┘
               │
┌──────────────▼─────────────────────────────────────────────────┐
│ Express                                                        │
│  helmet → cors(allowlist) → requestId → json → rateLimit       │
│    ├─ POST /api/auth/login    loginLimiter, bcrypt, set cookie │
│    ├─ POST /api/auth/logout   clear cookie, revoke session     │
│    ├─ GET  /api/auth/me       → {username, role, permissions}  │
│    │                                                           │
│    ├─ requireAuth ─────────── verify session cookie            │
│    ├─ requirePermission(...) ─ RBAC gate per route             │
│    ├─ validate(schema) ─────── reject bad regNo/dates BEFORE EMR│
│    ├─ applyDataScope ───────── narrow ward/unit/date window     │
│    └─ auditLog ─────────────── who / what / when / result       │
│                                                                │
│  Services                                                      │
│   authService     — bcrypt, sessions, lockout                   │
│   rbacService     — role → permission resolution                │
│   emrClient       — ONE shared EMR session, bounded concurrency │
│   chartBuilder    — pure assembly logic, unit-testable          │
│   cacheService    — Mongo-backed chart cache w/ TTL             │
│   auditService    — append-only access log                      │
│   maskingService  — field/test redaction by role                │
└──────────────┬─────────────────────────────────────────────────┘
               │
┌──────────────▼──────────┐   ┌────────────────────────────────┐
│ MongoDB (authenticated) │   │ External EMR                   │
│  users, roles, sessions │   │  parameterised query endpoint  │
│  audit_log, chart_cache │   │  (target; raw SQL today)       │
│  settings               │   └────────────────────────────────┘
└─────────────────────────┘
```

**Session choice: httpOnly + Secure + SameSite=Strict cookie holding an opaque session ID**, with
the session record in Mongo — not a JWT in `localStorage`. Reasons: server-side revocation
(force-logout, and a role change takes effect immediately), no token readable by injected JS, and
idle timeout becomes trivial. The unused `JWT_SECRET` in `.env` should be removed or repurposed as
the cookie signing secret.

### 6.1 Upgraded request flow

```
LOGIN
  POST /api/auth/login
    → rateLimit (5 attempts / 15 min / IP+username)
    → validate body shape
    → users.findOne({username, active: true})
    → bcrypt.compare(password, user.passwordHash)      ← constant-time
    → on fail: increment failedAttempts; lock at 5 for 15 min; audit LOGIN_FAILED
    → on success: reset counter, create session doc
        {sessionId, userId, role, ip, userAgent, createdAt, expiresAt, lastSeenAt}
    → Set-Cookie: sid=<opaque>; HttpOnly; Secure; SameSite=Strict; Max-Age=8h
    → audit LOGIN_SUCCESS
    ← {username, role, permissions[]}     ← UI uses this to shape itself

EVERY PROTECTED REQUEST
  → requireAuth: read sid cookie → sessions.findOne → check expiresAt
      → idle > 30 min? destroy + 401 SESSION_IDLE
      → else slide lastSeenAt
  → requirePermission('investigation:search')
  → validate: regNo /^(IP)?\d{1,15}$/i ; dates real, from ≤ to, span ≤ maxRangeDays(role)
  → applyDataScope: clamp date span, restrict ward/unit if role is scoped
  → cacheService.get(regNo+from+to) → HIT? serve (audit CACHE_SERVE) and return
  → emrClient: ONE login, bounded-concurrency fetch of order HTML
  → chartBuilder: pure function over fetched rows
  → maskingService: strip tests/fields the role may not see
  → cacheService.set(TTL 10 min)
  → auditService: {userId, action:'SEARCH', regNo, range, resultCount, ms, requestId}
  ← sanitised payload (no raw EMR errors, no SQL, no stack traces)
```

### 6.2 What the client stops doing

- `sessionStorage.getItem('investigation-auth')` is no longer the source of truth. On mount the app
  calls `GET /api/auth/me`; the cookie either resolves to a live session or it does not.
- `api/client.js` gains `credentials: 'include'`, a single error normaliser, and a global 401
  handler that drops the user back to the login screen with "Your session expired".

---

## 7. RBAC — what can actually be controlled

This is the part you asked about most directly, so it is the most detailed section. The model is
**role → permissions → data scope → field visibility → UI shaping**, with every check enforced on
the server. Client-side hiding is cosmetic only; it must never be the gate.

### 7.1 Proposed roles

| Role | Intended user | One-line summary |
|---|---|---|
| `admin` | IT / system owner | Everything, including user management and settings. |
| `doctor` | Treating physician | Full clinical read, long date ranges, print/export, all tests. |
| `nurse` | Ward nursing staff | Read + print for their ward, shorter ranges, no export. |
| `lab_tech` | Lab staff | Raw results and order detail; chart view optional; no PHI export. |
| `front_desk` | Registration/clerical | Verify a UHID exists. **No results at all.** |
| `auditor` | Compliance | Read audit logs only. No patient data. |

Roles live in a Mongo `roles` collection so permissions can be retuned without a redeploy. The
`users` doc carries `role` plus optional per-user overrides.

### 7.2 Permission catalogue — the controllable surface

**A. Feature / action permissions**

| Permission | Gates |
|---|---|
| `investigation:search` | Use the search bar at all (`POST /api/search`) |
| `investigation:view_chart` | See the Investigation Chart tab |
| `investigation:view_raw` | See the Raw Results tab |
| `investigation:view_detail` | Open the per-order DetailModal (`GET /api/detail/:id`) |
| `investigation:print` | See and use the Print button |
| `investigation:export_csv` | Export to CSV/Excel (new) |
| `investigation:export_pdf` | Server-rendered PDF (new) |
| `patient:view_demographics` | See the name/age/sex/bed patient strip |
| `patient:lookup_only` | Confirm a UHID exists without seeing any results |
| `admin:users_read` / `admin:users_write` | View / create-edit-disable users |
| `admin:roles_write` | Change role definitions |
| `admin:settings_write` | Hospital letterhead, chart template, cache TTL |
| `admin:auth_sync` | Trigger `update-auth.js` from the UI |
| `audit:read` | Read the access log |
| `audit:export` | Export audit reports |
| `cache:invalidate` | Force-refresh a cached chart |

**B. Data-scope controls** (which records, not which buttons)

| Control | Field | Effect |
|---|---|---|
| Date-range ceiling | `maxRangeDays` | `nurse` 30 days, `doctor` 365, `admin` unlimited. Enforced in `validate`. |
| Historical depth | `maxHistoryMonths` | Block searches older than N months. |
| Ward restriction | `allowedWards[]` | Rows whose ward is outside the list are dropped. |
| Unit/department | `allowedUnits[]` | Same for ordering department. |
| Patient-type | `allowedPatientTypes[]` | e.g. IP only vs IP+OP. |
| Own-patients-only | `ownPatientsOnly` | Restrict to patients where the user is treating doctor. |
| Result-status | `allowedStatuses[]` | Hide `pending`/unapproved results from non-lab roles. |
| Rate/volume cap | `maxSearchesPerHour` | Blunts bulk PHI harvesting. |

**C. Field / test-level visibility** (the genuinely sensitive axis in a hospital)

| Control | Effect |
|---|---|
| `sensitiveTestGroups[]` | Deny-list per role for HIV/serology, genetics, psychiatric, oncology markers. Stripped **server-side** before the response is built. |
| `maskDemographics` | Replace patient name with initials, drop age/bed for clerical roles. |
| `showReferenceRanges` | Hide ref-range column where it invites amateur interpretation. |
| `showAbnormalFlags` | Toggle the ↑/↓ + colour cues. |
| `showRawEmrColumns` | Restrict the "every EMR column" dump to lab/admin roles. |

**D. Print / export controls**

| Control | Effect |
|---|---|
| `watermarkOnPrint` | Stamp "CONFIDENTIAL — <username> — <timestamp>" on printed charts. Deters photo leaks, makes provenance traceable. |
| `printRequiresReason` | Prompt for a reason, recorded in the audit log. |
| `maxExportRows` | Cap bulk extraction. |
| `exportFormats[]` | Which of CSV / XLSX / PDF are permitted. |

**E. Session / account controls**

| Control | Effect |
|---|---|
| `sessionTimeoutMinutes` | Short (10 min) for shared ward terminals, longer for offices. |
| `idleLockMinutes` | Auto-lock overlay requiring re-entry of password. |
| `allowedIpRanges[]` | Restrict clerical/admin roles to on-premise subnets. |
| `allowedHours` | Optional shift-window restriction. |
| `concurrentSessionLimit` | Discourage credential sharing. |
| `mustChangePassword` | Force rotation on first login. |

### 7.3 Suggested default matrix

| Permission / control | admin | doctor | nurse | lab_tech | front_desk | auditor |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| `investigation:search` | ✅ | ✅ | ✅ | ✅ | ⚠️ lookup only | ❌ |
| `investigation:view_chart` | ✅ | ✅ | ✅ | ⚙️ | ❌ | ❌ |
| `investigation:view_raw` | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ |
| `investigation:view_detail` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `investigation:print` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `investigation:export_csv` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `patient:view_demographics` | ✅ | ✅ | ✅ | ⚠️ masked | ⚠️ masked | ❌ |
| `admin:users_write` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `audit:read` | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ |
| `maxRangeDays` | ∞ | 365 | 30 | 90 | — | — |
| `sensitiveTestGroups` blocked | none | none | HIV, genetics | none | all | all |
| `sessionTimeoutMinutes` | 60 | 30 | 15 | 30 | 15 | 30 |
| `watermarkOnPrint` | off | on | on | — | — | — |

✅ allowed · ❌ denied · ⚠️ allowed but masked/limited · ⚙️ configurable

These are a starting point for discussion with your clinical and compliance stakeholders, not a
prescription — ward/unit scoping in particular depends on how your EMR populates those columns.

### 7.4 Enforcement rule

Three layers, and the order matters:

1. **Route gate** — `requirePermission('investigation:search')` returns 403 before any handler runs.
2. **Data scope** — applied to the query *and* to the result rows (`applyDataScope`), so a scoped
   user cannot widen their own window by editing the request payload.
3. **Field masking** — `maskingService` strips denied tests/fields from the assembled payload
   *before* serialisation.

Only after all three does the UI hide buttons. If a permission is enforced only in React, it is not
enforced. Every 403 is written to the audit log — repeated denials are a useful intrusion signal.

### 7.5 Data model additions

```javascript
// users
{ _id, username, passwordHash, displayName, role: 'nurse',
  active: true, mustChangePassword: false,
  scope: { allowedWards: ['ICU','MW1'], maxRangeDays: 30 },
  overrides: { 'investigation:export_csv': true },   // per-user exception
  failedAttempts: 0, lockedUntil: null,
  createdAt, updatedAt, lastLoginAt }

// roles
{ _id, name: 'nurse', label: 'Ward Nurse',
  permissions: ['investigation:search','investigation:view_chart', ...],
  limits: { maxRangeDays: 30, sessionTimeoutMinutes: 15, maxSearchesPerHour: 60 },
  visibility: { sensitiveTestGroups: ['HIV','GENETICS'], maskDemographics: false },
  isSystem: true }

// sessions
{ _id: sessionId, userId, role, ip, userAgent,
  createdAt, lastSeenAt, expiresAt }        // TTL index on expiresAt

// audit_log   (append-only; never expose PHI values, only identifiers)
{ _id, at, userId, username, role, action: 'SEARCH',
  target: { regNo, fromDate, toDate }, resultCount, ms,
  outcome: 'ALLOWED'|'DENIED'|'ERROR', reason, ip, requestId }

// chart_cache
{ _id: 'regNo|from|to', payload, builtAt, expiresAt }   // TTL index

// settings
{ _id: 'hospital', logoPath, nameEn, nameTa, address, updatedBy, updatedAt }
```

`sessions` and `chart_cache` should use Mongo TTL indexes so expiry is automatic rather than
application-managed.

---

## 8. Design-level upgrades

Still plain CSS, still no component library. The aim is to make a dense clinical grid readable at a
glance, on a tablet, and in print.

### 8.1 Design tokens

`App.css` already has a `:root` colour block — extend it rather than replacing it, so nothing has to
be rewritten at once:

```css
:root {
  /* existing colours kept as-is */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
  --text-xs: 11px; --text-sm: 13px; --text-md: 14px; --text-lg: 18px;
  --shadow-1: 0 1px 2px rgba(15,23,42,.06);
  --shadow-2: 0 12px 28px rgba(15,23,42,.08);
  --chart-row-h: 30px;
}
```

Then split the single 957-line stylesheet into `tokens.css`, `base.css`, `components.css`,
`chart.css`, `print.css`, imported from one `index.css`. Same output, far easier to navigate.

### 8.2 Chart readability (the core screen)

| Change | Why |
|---|---|
| Sticky Parameter + Ref. Range columns | Scroll a 20-day admission without losing the test name. |
| Sticky date header row | Same, vertically. |
| Zebra striping + hover row highlight | Eye-tracking across a wide row is the #1 chart complaint. |
| Abnormal cells: colour **plus** ↑/↓ glyph and bold weight | Colour-blind safe; survives mono printing. |
| Compact / comfortable density toggle | Ward rounds want compact; review wants comfortable. |
| "Abnormal only" filter | Turns a 60-row chart into the 6 rows that matter. |
| Inline sparkline per test row | Trend at a glance without a separate view. |
| Click a row → mini trend chart | Progression over the admission. |
| Section collapse/expand with memory | Skip HAEMATOLOGY when reviewing BIOCHEMISTRY. |
| Freeze/pin a test row | Compare creatinine against everything else. |

### 8.3 Login screen

The eye toggle is now in place. Remaining polish: caps-lock warning, inline validation before
submit, a specific message for locked accounts ("Account locked for 15 minutes"), hospital logo
instead of the 🔐 emoji, and `autoFocus` on the username field.

### 8.4 Layout & responsive

- App shell with a slim top bar: hospital logo, app name, current user + role badge, session timer,
  logout. Replaces the current bare `<h2>` + Logout row.
- Search bar becomes a sticky card that collapses to a one-line summary after a search, reclaiming
  vertical space for the chart.
- Below 900px: search fields stack, chart switches to horizontal scroll with the sticky columns
  doing the work, patient strip becomes a two-column grid.
- Skeleton loaders shaped like the chart instead of one centred spinner.
- Toast notifications for transient outcomes; keep the inline red block for real errors.

### 8.5 Accessibility (currently unaddressed)

- Every icon-only control needs an `aria-label` (the new eye toggle has one; `req-badge` in
  `RawResults` uses `role="button"` + `tabIndex` but no label).
- Colour must never be the sole signal (U9) — WCAG 1.4.1.
- Verify 4.5:1 contrast on `--muted` `#64748b` over `#f8fafc`.
- Modal needs a focus trap and `aria-modal="true"`; `DetailModal` handles Escape but not focus.
- Chart tables need `<caption>` and `scope="col"` / `scope="row"`.
- Add a visible skip-to-content link and test the whole flow keyboard-only.
- Announce loading/results via `aria-live` so screen readers hear that a search finished.

### 8.6 Print / PDF

Replace the duplicated print DOM (`InvestigationChart.jsx` renders the chart twice) with a
server-rendered PDF endpoint. That gives identical output across browsers, lets you stamp the
per-role watermark reliably, and halves the render cost of the chart component. Keep
`window.print()` as a fallback.

---

## 9. Phased roadmap

Phases are ordered by risk reduction per unit of effort. **Phase 1 is not optional** — until it
lands, patient data is readable by anyone who can reach the port.

### Phase 1 — Stop the bleeding (1–2 days)

| Task | Files | Fixes |
|---|---|---|
| `requireAuth` middleware + httpOnly cookie sessions | new `middleware/auth.js`, `index.js` | S1, S3 |
| Apply it to `/api/search`, `/api/detail/:id` | `index.js` | S1 |
| Validate `regNo` (`/^(IP)?\d{1,15}$/i`) + real dates | new `middleware/validate.js` | **S2** |
| bcrypt hashing end-to-end | `authService.js`, `update-auth.js`, `auth.json` | S4, S14 |
| `git rm --cached auth.json`, gitignore it, **rotate all passwords** | repo | S5 |
| Bind Mongo to `127.0.0.1:3000` + enable auth | `docker-compose.yml` | S6 |
| `express-rate-limit` on `/api/login` | `index.js` | S7 |
| `helmet()` + CORS allowlist | `index.js` | S8, S11 |
| Generic client-facing errors, details to logs only | `index.js` | S9 |
| Drop the auth.json fallback once Mongo is authoritative | `authService.js` | B10 |

New deps (pin exact versions): `bcrypt`, `helmet`, `express-rate-limit`, `cookie-parser`.

### Phase 2 — RBAC foundation (3–5 days)

Mongo `users`/`roles`/`sessions` collections · `rbacService` · `requirePermission` ·
`GET /api/auth/me` · UI shaped from returned permissions · `audit_log` collection and
`auditService` on every data access · admin user-management screen (`admin:users_write`).

### Phase 3 — Backend hardening & performance (3–5 days)

Split `emrService.js` into `emrClient` + `chartBuilder` (pure, unit-testable) · one EMR session per
request · bounded concurrency (4–6) · Mongo chart cache with TTL · TTL on `dynamicTestGroups` ·
structured logging with request IDs · real `/api/health` that pings Mongo and EMR · graceful
shutdown · `node:test` suite around `chartBuilder`, `dateUtils`, `htmlParser`, and RBAC.

### Phase 4 — UX & design (4–6 days)

Default 7-day range and preset chips · friendly error mapping · sticky columns/header · abnormal-only
filter · ↑/↓ markers · recent searches · URL-encoded search state · CSV export · skeletons ·
responsive pass · accessibility pass · split CSS with tokens.

### Phase 5 — Operational maturity (ongoing)

TLS at nginx with HSTS · server-rendered PDF with per-role watermark · audit dashboard for
`auditor` · per-user EMR credentials to kill the shared service account (S10) · settings UI for
letterhead and chart template · remove `server.zip`, `client/dist.zip`, `dummy.json`, and the
`test_*.js` scripts that have been superseded (S16) · fix the README's wrong ports (B9).

---

## 10. Quick wins (under an hour each)

1. Default `fromDate` to 7 days ago — removes the most common empty result.
2. `helmet()` — one line, adds a baseline of security headers.
3. Rate-limit `/api/login` — one middleware, kills brute force.
4. `regNo` regex validation — one line, closes the injection vector at the edge.
5. Replace `error.message` in responses with generic text; log the detail.
6. Sticky first two chart columns — pure CSS.
7. ↑/↓ abnormal markers — small change in `getStatusColor`'s call site.
8. Fix the README ports (`8080`/`3001`/`6001` → `1000`/`2000`).
9. `git rm --cached auth.json` and add it to `.gitignore`.
10. Delete `server.zip`, `client/dist.zip`, `dummy.json`.

---

## 11. Explicit assumptions & limitations

- **I did not implement any of this.** This document is analysis and proposal only; the sole code
  changes in this session were the earlier login fix, the Mongo sync/config reconciliation, and the
  password eye toggle.
- The RBAC role names, permission list, and default matrix are my proposal. They need review by
  whoever owns clinical governance — particularly which test groups count as sensitive, and whether
  ward/unit scoping is even populated reliably in your EMR data.
- I could not inspect the EMR side. Whether a parameterised alternative to `strQuery` exists is
  unknown to me; that requires a conversation with the EMR vendor/team.
- Effort estimates assume one developer familiar with this codebase and exclude review and
  deployment.
- I could not run the Docker stack (this shell is not in the `docker` group and `sudo` requires
  interactive auth), so all live verification was against the host dev server on port 2999.
- Compliance frameworks (HIPAA, India's DPDP Act, NABH) are referenced only implicitly through the
  audit-log and access-control recommendations. I am not giving legal advice; a compliance review is
  a separate exercise.

---

## 12. Verification log

**Confirmed by reading source:** every file in the source map (§1.2); the absence of
`jsonwebtoken`/`bcrypt`/`helmet`/`express-rate-limit`/`cookie-parser` from `server/node_modules`;
zero `jwt`/`token` references in `server/src` and `client/src`; the SQL string interpolation at
`emrService.js:54-70`; the per-order login loop; plaintext `===` comparisons; `auth.json`,
`server.zip`, `client/dist.zip`, `dummy.json`, and `investigation.php` all tracked by git while
`server/.env` correctly is not.

**Confirmed by live request:** `POST /api/search` returns HTTP 200 with no credentials;
`GET /api/config/hospital` returns HTTP 200 with no credentials; all four `auth.json` users
authenticate on the host dev server; Mongo on host port 3000 contains exactly
`admin, user1, user2, user3` in `investigation-chart.auth`.

**Inferred, not verified:** the EMR's actual privilege level for `BB_CONSTR` (so the blast radius of
S2 is unknown but assumed significant); real-world search latency under load; whether ward/unit
columns are consistently populated; the container image's exact running code (the `:2000` container
predates this session's changes and I could not rebuild it).

