# AI_FOR_AOSTRA — "Ask AI" as its own application

**What this is:** a complete specification for rebuilding the portal's **Ask AI** assistant as a standalone, chat-only app, with the same behaviour. It covers what it answers, how, with which data, and what it must never do.

**Source of truth:** the working implementation in this repository. Where this document and the code disagree, the code wins. Main files:

| Area | File |
|---|---|
| Assistant: system prompt, tools, model calls, fallback | `server/src/services/assistantService.js` |
| Find a patient by any value | `server/src/services/patientSearchService.js` |
| Patient details, journey, compare | `server/src/services/patientInsightService.js` |
| Lab values store and search | `server/src/services/labResultsService.js` |
| OP / any-UHID lab report from the EMR | `server/src/services/labLookupService.js` |
| Numbered results and chat exports | `server/src/services/chatResultsService.js` |
| Discharge report | `server/src/services/dischargeReportQuery.js` |
| WhatsApp (WATI) send, number checks, templates | `server/src/services/watiService.js` |
| WhatsApp message log, statuses, webhook, retries | `server/src/services/whatsappLogService.js` |
| Test WhatsApp message | `server/src/services/whatsappTestService.js` |
| EMR access (login, query builder, lab pages) | `server/src/services/emrService.js` |
| Discharge list ingestion and report records | `server/src/services/dischargeReportService.js` |
| Lab report PDF (chart) | `server/src/services/investigationPdfService.js` |
| Discharge summary PDF | `server/src/services/dischargeSummaryService.js` |
| Built-in manual for "how / what does … mean" | `server/src/services/appGuide.js` |
| Chat UI | `client/src/components/AssistantPanel.jsx` |

The environment template is **`AI_FOR_AOSTRA.env.example`**, next to this file. The two PDF templates (Lab Report and Discharge Summary), with sample PDFs, are in **`templates/`** (section 26).

---

## 1. What the app does

A chat for hospital staff at **Adhiparasakthi Hospitals** (Melmaruvathur). Staff type any question in English, Tamil or another language. The assistant answers with real hospital data and shows the data as cards and tables they can open, download or send on WhatsApp.

It must handle all of these:

| Kind of question | Examples |
|---|---|
| Find a patient by **any value** | "find the patient with phone 98765 43210", "IP07028148", "6159338", "arun kumar", "who is from Tindivanam", "patient in bed 312", "Req No 2611034" |
| One patient's facts | "WhatsApp number and discharge time of IP07028148 in 12-hour format", "age and address of 98765 43210", "length of stay", "diagnosis", "which doctor" |
| Lab report / discharge summary PDFs | "IP07028148 lab report", "send the summary of this patient", "download it as PDF" |
| Lab values across patients | "patients with urine glucose negative last week", "haemoglobin below 8 in September", "abnormal creatinine yesterday" |
| Out-patient (OP) lab report | "lab report of UHID 6159338" when not discharged: fetched live from the EMR lab and turned into a PDF |
| Discharge lists and reports | "today's discharges", "patients discharged today 10 am to 2 pm", "ENT discharges this week with No Summary" |
| WhatsApp delivery | "today's WhatsApp report patient and message wise", "failed messages yesterday", "WhatsApp messages of IP07028148" |
| Live status | "is WhatsApp working?", "why didn't the report go?", "WATI 429?", "when is the next discharge check?" |
| Patient journey | "journey of IP07028148", "flowchart of what happened to this patient" |
| Compare | "compare IP… and IP…", "compare her first and last lab day" |
| Files from the chat | "put #1 and #2 in one PDF and the rest in a CSV", "everything in one Excel" |
| Test WhatsApp | "send a test message" → asks for the text → asks for the number → confirmation card → Send |
| How-to and meaning | "what does the red No Summary button mean?", "what is a blue tick?" (answered only from the manual) |

**Patient scope:** the hospital data is about **discharged in-patients (IP)**. **OP patients appear only inside the chat**, through the EMR lab lookup, and are never added to any list or report.

---

## 2. Non-negotiable behaviour

The assistant must behave exactly like this. Each rule exists because the opposite happened, or would be harmful.

1. **Never invent data.** Names, IP numbers, UHIDs, values and counts come only from tools. If a tool finds nothing, say so.
2. **Use a tool for anything about patients, reports or lab results.** Never answer such a question from memory.
3. **Find a patient by anything, across every date.** Pass the user's exact text to `find_patient`, never only today. Say who it is and **what matched** (e.g. "matched on mobile number"). If several match, say how many and that they're best match first.
4. **Answer the question itself, not just "details are below".** "Age and discharge time of …" gets a real sentence with the age and the time, in the format asked ("29/09/2026, 12:24 PM", 12-hour, "3 days 4 hours").
5. **Not in the discharge data, but given a UHID or IP number?** Try `lab_report_lookup` (EMR lab, default last 30 days). Say plainly that OP patients exist only in the chat.
6. **Nothing is sent on WhatsApp without the user pressing Send** on a card, or saying "yes" to that exact card. The model never sends; it only prepares cards.
7. **Never say "sent" unless the tool returned `sent: true`.** Never claim delivered or read unless the status says so.
8. **Check a WhatsApp number before preparing a send.** If it's wrong, say exactly why ("That number has only 9 digits — please enter the full 10-digit mobile number") and ask again.
9. **WhatsApp status questions come from live status.** If `watiApi` is `UNKNOWN`, say it isn't known yet whether WATI is accepting messages. Never say "WhatsApp is working" without evidence.
10. **Answer "how / what does … mean" only from the manual** (`app_help`). Never invent buttons, menus or settings.
11. **Never mention tool names.** Offer to do the thing instead ("Shall I make a PDF of these?").
12. **Number every result in a chat** (#1, #2 …) so the user can say "put #1 and #2 in a PDF".
13. **Dates:** tools use `YYYY-MM-DD`; replies use `DD-MM-YYYY`. All times are **India time (Asia/Kolkata)**. "Today", "yesterday", "last week" and "this month" are resolved from today's IST date, given in the prompt.
14. **Keep replies short:** 1–4 sentences, or a few numbered steps. Don't paste long lists; the table is on screen.
15. **Reply in the user's language.** English by default; Tamil (or any other language) if they write in it.
16. **Respect the user's permissions.** Offer the model only tools the user may use, and check again when a tool runs. If access is missing, say "your account doesn't include that — the super admin can add it".
17. **Privacy:** ABHA ID, religion, MLC and MLC record number are never sent to the AI provider (they may be shown on screen). A switch can keep all patient details away from the provider; the model then gets counts only.
18. **When the AI provider is down or rate-limited**, a rule-based fallback still answers common questions with the same tools (section 17). Never show a raw error for that.
19. **"Cancel" while a test message is being prepared cancels it immediately**, without the model: "Okay, cancelled — nothing was sent."

---

## 3. Architecture

```
Browser (chat UI)
   │  POST /api/assistant  { messages: [{role, content}], context: {...}, chatId }
   ▼
Server (Node 20+, Express, ESM)
   1. sanitise context; load this chat's numbered results (#1, #2 …)
   2. build the system prompt (today in IST, user's access, what's on screen, results so far)
   3. offer only the tools this user may use
   4. loop up to 6 rounds:
        model call (Groq → Gemini fallback chain, OpenAI-compatible /chat/completions)
        └─ tool_calls? run each handler (Mongo / EMR / MinIO / WATI), number its card,
           send JSON "forModel" back to the model, keep "block" for the UI
        └─ no tool_calls? that text is the reply
      no model answers → describe the cards already made, or run the rule-based fallback
   5. return { reply, blocks: [...cards], fallback? }
   ▼
Browser renders the reply text and each card (patients, lab table, report, status, PDF, journey, compare, file, WhatsApp card …)
```

- Each tool returns **`{ forModel, block? }`**: `forModel` goes back to the AI (facts only), and `block` is the card shown to the user.
- Cards with data get a number per chat (`#n`), stored for 2 days, so later turns can export them.
- The server keeps no chat state besides the numbered results. The browser sends the visible history and the small `context` object every time.

**Suggested stack** (the same as the portal, so code can be copied): Node 20 ESM + Express, MongoDB 7, MinIO (S3) for PDFs, Chromium + puppeteer-core for HTML→PDF and the discharge summary page, React + Vite for the UI, and Docker Compose.

---

## 4. Data

### 4.1 Two ways to get the data — choose one

**A. Share the portal's data (recommended).** Run the new app next to the portal on the same server and Docker network. Point it at the **same MongoDB and MinIO**. The portal keeps running the 15-minute EMR discharge check, making PDFs, storing lab values and sending and logging WhatsApp. The AI app reads that data. It writes only:
- its own chat results (`assistant_results`), and
- new WhatsApp sends (into `whatsapp_messages`, same schema, so the portal's Monitor and webhook keep them up to date).

**B. Fully independent.** The new app must also run the ingestion described in 4.5 (EMR discharge list → lab chart PDF → lab values → discharge summary PDF), its own WhatsApp log and its own WATI webhook. This doubles load on the EMR; only do it if the portal will be retired.

### 4.2 MongoDB collections (database `investigation-chart`)

**`discharge_reports`**: one document per discharged patient per discharge date (`{date, ipNo}` is unique).

| Field | Meaning |
|---|---|
| `date` | Discharge date folder `YYYY-MM-DD` (the date the reports are filed under) |
| `ipNo` | IP number, e.g. `IP07028148` |
| `regNo` | UHID (registration number), digits |
| `name` | Patient name as in EMR, e.g. `Mr.RAMESH K`, `BABY.ARUN KUMAR` (HTML stripped) |
| `age`, `gender`, `patientType` | e.g. `47 Y`, `MALE`, `General` / `Corporate` |
| `mobile`, `whatsapp` | Mobile from EMR (10 digits usually); EMR "WhatsApp No" (often empty) |
| `department`, `doctor`, `ward`, `bedNo` | From EMR |
| `admissionDate`, `dischargeDate` | EMR text `DD-MM-YYYY HH:mm` (India time) |
| `dischargeType` | e.g. `Normal`, `AMA` |
| `createdUser` | EMR user who created the discharge |
| `emr` | **Every non-empty column of the EMR discharge row** (address, City, District, State, RELATION, RELATION NAME, AREA / VILLAGE, IP_Diagnosis, REFERRAL DOCTOR, DURATION, EMAIL …), HTML stripped, ≤300 chars each |
| `dateCount` | Number of lab days in the lab report. **Absent = no lab report** ("No lab data") |
| `reqNos` | Lab request numbers (strings) in the report |
| `hasSummary`, `summaryDataMissing` | Summary PDF exists; `true/true` = the red **No Summary** (EMR had no data) |
| `summaryApprovedBy` | Doctor who approved the summary |
| `generatedAt` | ISO time the lab report was made |

**`lab_results`**: one row per test per result day per patient (searchable lab values).

| Field | Meaning |
|---|---|
| `dischargeDate`, `ipNo`, `regNo`, `name`, `department`, `doctor`, `ward`, `patientType` | Copied from the patient |
| `section` | Test group (e.g. `RENAL FUNCTION TEST`), `''` if none |
| `test` | Test label, e.g. `GLUCOSE`, `HAEMOGLOBIN`; same-day repeats are labelled `HAEMOGLOBIN (14:20)` |
| `range` | Reference range text, e.g. `13 - 17`, `< 200`, `upto 40` |
| `value` | Result text, e.g. `12.4`, `NEGATIVE`, `NIL` |
| `numeric` | Parsed number or `null` |
| `status` | `high` / `low` / `normal` / `null` (section 9) |
| `resultDate` / `resultDay` | `DD-MM-YYYY` / `YYYY-MM-DD` |
| `searchText` | Uppercase `"<section> <test>"`, for word search |

**`whatsapp_messages`**: one document per WhatsApp message (each PDF is its own message).

| Field | Meaning |
|---|---|
| `createdAt`, `acceptedAt`, `deliveredAt`, `readAt`, `failedAt` | Timestamps |
| `status` | `pending` → `sent` → `delivered` → `read`, or `failed` |
| `notOnWhatsApp` | Failure was "not on WhatsApp" (WATI `validWhatsAppNumber: false`, or text matching `/not (a\|on) whatsapp\|not a valid whatsapp\|invalid whatsapp\|not.*whatsapp user\|131026/i`) |
| `error`, `failedDetail` | Failure text |
| `trigger` | `auto` / `manual` / `share` / `retry` |
| `via` | e.g. `assistant` for sends from the chat |
| `triggeredBy` | Username, or `system` |
| `document`, `documentLabel` | `lab` / `summary` / `lab_results` / `other`; e.g. `Lab Report`, `Test message`, `Lab Report (Ask AI)` |
| `dischargeDate`, `ipNo`, `uhid`, `patientName`, `recipientName`, `department` | Who it was for |
| `toNumber` | Digits, e.g. `919876543210` |
| `template`, `liveMode`, `numberEdited` | Template name; Live mode at send time; staff edited the number |
| `watiSendIds`, `whatsappMessageId`, `watiMessageId`, `watiLocalMessageId` | Ids used to match webhooks / status checks |
| `attempts`, `nextRetryAt`, `autoRetry`, `rateLimited` | Retry state |
| `history[]` | `{status, at, source: 'app'\|'webhook'\|'wati', note}` |

**`assistant_results`**: the chat's numbered results. Docs `{chatId, user, at, n, kind: 'result', title, question, block}` and `{… kind: 'turn', question, reply}`. **TTL 2 days** on `at`; index `{chatId, n}`.

Optional, if shared with the portal: `audit_events` (staff actions, used in the journey timeline), `app_settings` (Master Settings), `wati_usage` (API usage counters).

### 4.3 MinIO object keys (bucket `investigation-reports`)

| Object | Key |
|---|---|
| Lab report PDF | `<YYYY-MM-DD>/<IPNO>.pdf` |
| Discharge summary PDF | `<YYYY-MM-DD>/<IPNO>-summary.pdf` |
| Chat lab lookup PDF (OP or any UHID) | `lookups/<YYYY-MM-DD>/<12-hex-id>.pdf` |
| Chat export file | `chat-exports/<YYYY-MM-DD>/<id>.<pdf\|xlsx\|csv>` |
| Test-message PDF | `tests/<YYYY-MM-DD>/whatsapp-test-<8hex>.pdf` |

### 4.4 EMR access (`https://emr.mapims.edu.in/BB15SE`)

Every call uses JSON `Content-Type: application/json; charset=UTF-8` and a **60-second timeout**. Calls without a timeout have hung for minutes.

**Login (cookie session):** `POST EMR_LOGIN_URL` (`…/wsLogin.asmx/chkLoginNew`). Body: `{ "UsrName": EMR_USERNAME, "UsrPwd": EMR_PASSWORD, "LogOpt": "2" }`. Success means `data.d` (JSON-parsed if a string) is not `''`, `'0'`, `'-1'`, `0` or `-1`. Use a cookie jar (axios + tough-cookie) for the following page calls.

**Query builder (no login needed):** `POST EMR_QUERY_BUILDER_URL` (`…/QueryBuilder/wsQueryBuilder.asmx/Getdataset1`). Body: `{ "strQuery": "<SQL>", "strCon": "BB_CONSTR" }`. The response `d` is a JSON string of rows.

- **Discharge list** for a date range (dates `MM/DD/YYYY`):
  ```sql
  Use kmch_frontoffice EXEC Fo_Rpt_IPPatdetailsprint_QB  @frmdate = '<MM/DD/YYYY>' , @todate = '<MM/DD/YYYY>' , @patname = '' , @regno = '' , @ipno = '<IPNO or empty>' , @docid = '0' , @MatrixFormat = '0' , @wardid = '0' , @Status = '1' , @PatType = '0' , @Corporate_type = '0' , @depid = '0' , @BedId = '0' , @RegDocCity = '0' , @optoip = '0' , @ReligionId = '0' , @RefDocDays = '0' , @VisitCategory = '' , @CorporateId = '' , @unit = '0' , @grpby = '0'
  ```
  - Columns include `REG NO`, `IP NO`, `PATIENT NAME` (an HTML anchor, so strip tags), `PATIENT TYPE`, `AGE`, `GENDER`, `MOBILE`, `WhatsApp No`, `DEPARTMENT`, `DOCTOR`, `WARD`, `BED NO`, `ADMISSION DATE`, `DISCHARGE DATE`, `DISCHARGE TYPE`, `CREATED USER`, `ADDRESS`, `City`, `District`, `State`, `RELATION`, `RELATION NAME`, `AREA / VILLAGE`, `IP_Diagnosis`, `DURATION` and more.
  - **Drop rows whose `PATIENT TYPE` is `ZPATIENT`** (EMR test patients).
- **Lab history** for a patient (dates `MM/DD/YYYY HH:mm`, e.g. `09/25/2026 00:00`):
  ```sql
  Use KMCH_Lab EXEC LabTestResultHistoryQB @FromDate = '<MM/DD/YYYY HH:mm>', @ToDate = '<MM/DD/YYYY HH:mm>', @RegNo = '<UHID or empty>', @RequestNo = '', @IPNO = '<IP or empty>', @BillNo = '', @PatName = '', @BedNo = '', @Dept = '', @Doc = '0', @Proc = '0', @PatCategory = '1,2,3', @Status = '0', @bDiscaintimation = '1', @PatType = '0', @Result = '1'
  ```
  - **Identifier fallbacks:** if the input contains "IP": `@IPNO` with the input, then without the "IP" prefix, then as `@RegNo`. Otherwise: `@RegNo`, then `@IPNO`, then `@IPNO` with "IP" prepended. The first non-empty result wins.

**Lab result page (needs the login cookie):** `GET EMR_LAB_URL_TEMPLATE + <Orderid>` (`…/Lab/LabResultHis.aspx?action=Search&Orderid=`). Parse the result table into rows `{section?, test, value, range}`. The order id comes from the lab history row's request-number cell.

**Test groups (once, cached):** `POST EMR_RET_DATATABLE_URL` (`…/Lab/wsLabServices.asmx/RETDatatable`) with a recursive SQL over `Mast_Proc` / `Mast_SubProc`. It maps each test to its package or category, ignoring department names (HAEMATOLOGY, BIOCHEMISTRY, CLINICAL PATHOLOGY, SEROLOGY, MICROBIOLOGY, HISTOPATHOLOGY, CYTOLOGY, MOLECULAR BIOLOGY, IMMUNOLOGY, BLOOD BANK).

**Building a lab chart** (`buildInvestigationChart`):
- **Skip:**
  - smear orders (`PERIPHERAL SMEAR` …)
  - narrative rows (CLINICAL DETAILS, CRITICAL VALUE, IMPRESSION, REMARK, COMMENT, SMEAR, PARASITE, NOTE…)
  - values or ranges longer than 30 characters, or narrative words (microcytic, hypochromic, …)
- **Repeats:** a test with two results on the same day gets a second row labelled with the time.
- **Date columns:** `DD-MM-YYYY`.
- **Window:** for discharged patients the search starts **one week before admission** (pre-admission buffer) and ends at discharge. If it finds nothing by IP, search by UHID.

**Discharge summary:** login → resolve the internal **IPID** with `POST {EMR_BASE_URL}/ward/WebService/IPSearchWard.asmx/GetPatdetail`. Payload: `{ Opt:1, Patname:'', Relname:'', Regno:'', IPno:<IP>, Wardid:0, Bedtype:0, Bedno:'', Phy:0, Age:0, Aflg:0, Agetwo:0, Sex:'', Pattype:1, Admfrmdt:'', Admtodt:'', Disfrmdt:'', Distodt:'', DOBdt:'', UsrId:'0', Cityid:'0' }` → `rows[0].IPID`.
- Then open `{EMR_BASE_URL}/ward/pSummary.aspx?Action=Print&preview=yes&opt=0&Sign=0&ipid=<IPID>&Companyid=undefined` **in headless Chromium with the session cookies**. The page fills itself by JavaScript, so a plain GET returns an empty shell.
- Restyle it, add the hospital letterhead, and print it to PDF.
- If the page has no patient data, the summary is still stored, marked `summaryDataMissing: true`. That is the red **No Summary**, and it is never sent to patients.

### 4.5 Ingestion (only for option B)

Every 15 minutes on the clock (`:00`, `:15`, `:30`, `:45` IST), for today's date:
1. Fetch the discharge list (4.4) and drop `ZPATIENT`.
2. For each patient, skip what already exists (lab PDF or "confirmed no lab data", and the summary PDF).
3. **Lab report:**
   - Build the chart (4.4), render the PDF to `<date>/<ip>.pdf`, then upsert `discharge_reports` (all baseline fields, `emr`, `dateCount`, `reqNos`) and replace `lab_results` rows.
   - "No lab orders" (by IP and by UHID, window from a week before admission) is final: mark it and don't recheck.
   - Technical errors: retry up to 4 times, 20 s apart.
4. **Discharge summary** (independent of the lab report): store `hasSummary`, `summaryDataMissing` and `summaryApprovedBy`.
5. **In Live mode** (option B only), send each newly made document on WhatsApp, logged with `trigger: 'auto'`.

---

## 5. The model layer

**Providers** (OpenAI-compatible chat APIs), tried in this order; the first one that answers wins:
- Groq `https://api.groq.com/openai/v1`, key `GROQ_API_KEY` (or `GROQ_API`). Models: `GROQ_MODELS`, default `openai/gpt-oss-120b, qwen/qwen3.8-27b, openai/gpt-oss-20b`.
- Gemini `https://generativelanguage.googleapis.com/v1beta/openai`, key `GEMINI_API_KEY`. Models: `GEMINI_CHAT_MODELS`, default `GEMINI_MODEL` (`gemini-3.6-flash`), `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-flash-lite-latest`.
- Providers without a key are skipped.

**Call** `POST {baseUrl}/chat/completions` with header `Authorization: Bearer <key>`:
```json
{ "model": "<model>", "messages": [...], "tools": [{ "type": "function", "function": <tool> }, ...], "tool_choice": "auto", "temperature": 0.2 }
```

**Failures and timing:**
- Timeout 25 s.
- On 429 with "try again in N s" and N ≤ 4: wait N s + 250 ms and retry once.
- A model that fails is skipped for a while: **45 s (or the provider's wait, if longer) after 429/503**, **20 s after other errors**. If every model is cooling down, try them all anyway.

**History sent:**
- Only `user` / `assistant` text messages, the **last 16**, each cut to 2,000 characters.
- Tool messages from earlier turns are not resent; the server rebuilds context from `context` and numbered results.

**Tool loop:**
- Up to **6 rounds**. Each round, run every `tool_call` in order:
  - Parse `arguments` JSON; bad JSON gives `{}`.
  - Unknown tool: `{"error":"Unknown tool"}`.
  - Tool not allowed: `{"error": NO_ACCESS}`.
  - Handler throws: `{"error": message}`.
- Push `{role:'tool', tool_call_id, content: JSON.stringify(forModel)}`.
- Before that, if the outcome has a block: number it (`#n`), and add `resultNumber` to `forModel` and the result to the "results so far" list. Update the turn's context:
  - `labResults` → `lastLabQuery`
  - `testDraft` → `testDraft`
  - a found `labLookup` → `lastLookup`
  - a `testMessage` with status `ready` → `pendingTest`
  - a `patients` card with exactly 1 patient → `lastPatient`
- A model message with no `tool_calls` is the final reply. Empty text becomes `"Done."`.
- Six rounds without a final reply: `"That took too many steps — please ask in a simpler way."`
- **No model answered:**
  - If cards were already made this turn, reply with `describeBlocks` (a sentence per card, e.g. `#1 Mr.X · IP…: age 47 Y, mobile …, discharged …` followed by `Details are below.`).
  - Otherwise run the rule-based fallback (section 17) and set `fallback: true`.

`NO_ACCESS` = `"This user's account has no access to that. Tell them to ask the super admin if they need it."`

---

## 6. System prompt

Build it fresh on every request. The text below is **verbatim** from the code; `{{…}}` are placeholders.

| Placeholder | Value |
|---|---|
| `{{HOSPITAL_NAME}}` | `HOSPITAL_NAME_EN` (default `Adhiparasakthi Hospitals`) |
| `{{WEEKDAY}}`, `{{TODAY_YYYY_MM_DD}}` | Today in **Asia/Kolkata**, e.g. `Saturday`, `2026-10-03` |
| `{{CHECK_MINUTES}}` | Discharge check interval (default `15`) |
| `{{LOOKUP_DAYS}}` | EMR lab lookup default range (default `30`) |
| `{{CONTEXT}}` | The context block below (empty string if nothing) |
| `{{PATIENT_DATA_RULES}}` | One of the two variants below, by the privacy switch |

```text
You are the help assistant inside the {{HOSPITAL_NAME}} Diagnostics Summary Portal, used by hospital staff.
Today is {{WEEKDAY}}, {{TODAY_YYYY_MM_DD}} (India time). Resolve "today", "yesterday", "last week", "this month" etc. from this date. Tool dates are YYYY-MM-DD; in replies write dates as DD-MM-YYYY.

Screens: Lab Search (one patient's results from the EMR), Discharge Reports (each discharged patient's Lab Report + Discharge Summary PDFs, made every {{CHECK_MINUTES}} minutes; WhatsApp button), Lab Finder (lab values across patients, exports), WATI Settings (Test mode / Live), WhatsApp Monitor (/admin: every WhatsApp message, delivered/read/failed, WATI quota).

{{CONTEXT}}
Rules:
- Use the tools for anything about patients, reports or lab results. Never invent names, IP numbers, values or counts.
- To find a patient by anything — IP number, UHID, mobile / WhatsApp number (any format or its last digits), name or part of it, lab Req No, bed, doctor, ward, address, town, relation's name — call find_patient with exactly what they typed. It searches every date (not just today) and shows their reports with download and WhatsApp options. Use it whenever someone asks "find / who is / which patient has …". Don't use discharge_report to look up one patient, and don't send them to Lab Search for that.
- A question about one patient given by their mobile number, name or anything else ("age and discharge time of the patient with number 98765 43210") goes straight to patient_details with that value as id — it accepts the same values as find_patient. Answer the question itself, not just "details are below".
- If find_patient finds the patient, say who it is and what matched (e.g. "Baby Arun Kumar, IP07000123, discharged 02-10-2026 — mobile 98765 43210 matches"). If several match, say how many and that they're listed best match first.
- If find_patient finds nothing for a UHID or IP number (often an OP / out-patient, who isn't in the discharge data), call lab_report_lookup with that number to search the EMR lab directly (last {{LOOKUP_DAYS}} days unless they give dates). OP patients exist only here in the chat — never say they'll appear in Discharge Reports. Once found, offer: open or download the PDF, or send it on WhatsApp. For WhatsApp ask "Which WhatsApp number should I send it to?", then call offer_lookup_whatsapp; if it says the number is wrong (e.g. only 9 digits), tell them exactly that and ask for the correct number. They press Send on the card, which then shows whether it was sent, not on WhatsApp, delivered or read.
{{PATIENT_DATA_RULES}}
- Patient journey / timeline / flowchart / "what happened to this patient": call patient_journey and describe it in order with dates and times.
- Compare two patients, or one patient's lab values on two dates ("compare this report with the earlier one", "how did her values change"): call compare_patients, then explain the main differences with numbers — which values rose or fell, which are out of range.
- Any other question about patients or data: work out which tools give the data, call them (several if needed), then answer with the numbers. Never say you can't when a tool can get it.
- Each result on screen is numbered #1, #2 … in this chat (listed above). To make files: call export_results with the numbers (empty = all) and a format — pdf, xlsx (Excel) or csv. Several files = several calls (e.g. #1 and #2 as one PDF, #3 as CSV). include_answers adds the questions and your answers. "Everything in one PDF" = all results, pdf.
- For lab questions use search_lab_results. Qualitative results (negative, positive, nil, trace, reactive) go in "value"; "high"/"low"/"abnormal" go in "status"; numbers in "min"/"max". If you're unsure of the test name, or the search finds nothing, call list_lab_tests and ask which test they mean.
- After showing results, offer the options: download as PDF, Excel, Word or CSV, or share on WhatsApp. When they pick a format, call offer_download. When they want WhatsApp, ask for the number if they haven't given it, then call offer_whatsapp_share. Never say a message was sent — the user confirms with the Send button.
- To take the user to a screen, call open_screen.
- Questions about the portal itself — how to do something, what a screen, button, badge, colour, tick or message means, why something happened, what a setting does — call app_help and answer only from what it returns. Never guess how the portal works.
- Reports: for WhatsApp delivery (patient-wise and/or message-wise), call whatsapp_report; for discharged patients (lists, counts, departments, doctors, lab / summary / WhatsApp status) call discharge_report. They take any dates plus an optional time window — "today 10 am to 2 pm" = from and to today, from_time 10:00, to_time 14:00; "yesterday evening" = 16:00–20:00. WhatsApp reports count patients by discharge date/time unless the user says "sent" (then date_basis sent). "patient and message wise" = view both. The table and downloads (Excel, PDF, CSV) appear on screen — summarise the totals in a sentence or two.
- Live questions — is WhatsApp working, why reports aren't sending, WATI usage limit / 429, Test or Live mode, webhook, PDF links, when the next discharge check runs — call app_status. For WhatsApp counts, failures or one patient's messages, call whatsapp_report. Combine with app_help to explain what to do. Give times as shown (India time). Report watiApi as given — if it says UNKNOWN, say it isn't known yet whether WATI is accepting messages.
- Only mention buttons, icons, menus and settings that app_help describes — never invent UI. Never mention tool names; offer to do it instead (e.g. "Shall I open the WhatsApp Monitor?").
- To send a test WhatsApp message, call send_test_whatsapp with whatever the user gave. If it says the message or the number is missing, ask for that one thing (message first, then number) and nothing else. When it shows the confirmation card, tell the user to press Send or say yes. Only say it was sent when the tool returns sent: true.
- For "how do I…" answers use short numbered steps with the screen names, and open the screen if it helps.
- Keep replies short (1-4 sentences, or a few steps). Reply in English, unless the user writes in Tamil or another language — then use that language.
```

**`{{PATIENT_DATA_RULES}}`, when patient data may go to the AI provider** (default, `AI_SHARE_PATIENT_DATA=on`):
```text
- Tool results come to you with the patient data, and also appear on screen as numbered results (#1, #2 …). Answer the question itself from the data — a mobile number, a discharge time, an age, an address, a value — formatted the way the user asks (e.g. "29/09/2026, 12:24 PM", 12-hour time, "3 days 4 hours"). Don't paste long lists; the table is on screen.
- For anything about one discharged patient (mobile / WhatsApp number, age, gender, address, city, relation, email, diagnosis, admission or discharge date and time, length of stay, doctor, ward, bed, reports, WhatsApp status, out-of-range lab values) call patient_details.
```

**When it may not** (`AI_SHARE_PATIENT_DATA=off`):
```text
- Tool results are shown to the user on screen; you only get counts. Don't repeat patient details — say briefly what was found and that it's shown below.
```

**`{{CONTEXT}}`**: built from the user's access and the `context` the browser sent. If there are no lines, it is the empty string; otherwise `"\nWhat the user is looking at now:\n" + lines.join("\n") + "\n"`. The lines, in this order, each only when it applies:

1. Access lines (only for a limited user):
   - `- This user has no access to: <names>. If they ask for those, say their account doesn't include it and the super admin can add it.`
   - `- Read-only for this user: <names>.`
   - `- This user only sees lab reports.` / `- This user only sees discharge summaries.`
   - `- This user can ask questions but not send or share on WhatsApp from Ask AI.`
2. `- Results so far in this chat: #1 <title>; #2 <title>.`
3. `- The user is on the <screen> screen. "This screen", "here" etc. mean it.` (portal only; leave out in the standalone app)
4. `- The latest lab results list on screen: test "<test>", result "<value>", flag <status>, from <from>, to <to>. "That list", "these results" etc. mean this — use target "lab_results".`
5. `- A lab report was just looked up for <id>. "Send it", "that report" mean this — use offer_lookup_whatsapp once you have a number.`
6. `- A test WhatsApp message is being prepared: "<message>" — the number is still needed.`
7. `- A test WhatsApp card is waiting for confirmation: "<message>" to +<digits>. If the user says yes / send / ok, call send_test_whatsapp with that message and number and confirm: true.`
8. `- The latest single patient shown: <IP> (discharged <YYYY-MM-DD>). "This patient", "their report" etc. mean this — use target "patient".`

**Edits for the standalone, chat-only app.** Only these four; keep everything else word for word.
1. Replace the "Screens: …" paragraph with: `This is the hospital's Ask AI app (chat only). The data comes from the Diagnostics Summary Portal: each discharged patient's Lab Report and Discharge Summary PDFs (made every {{CHECK_MINUTES}} minutes), stored lab values, and every WhatsApp message with its delivery status.`
2. Remove the rule `- To take the user to a screen, call open_screen.` and the `open_screen` tool. Optionally keep it as a link to the portal (section 16, `navigate`).
3. In the `app_help` rule, "the portal itself" becomes "the app and the hospital's reports / WhatsApp process". Point `app_help` at the standalone manual (section 22).
4. Leave out context line 3 (screen).

---

## 7. Tools

### 7.1 Definitions (verbatim, as sent to the model)

```json
[
  {
    "type": "function",
    "function": {
      "name": "find_patient",
      "description": "Find discharged patients by anything about them, across every date: IP number, UHID, mobile / WhatsApp number (any format, or its last digits), name or part of it (any order), lab Req No, bed, doctor, department, ward, staff who created it, relation name, address, town or village. Shows their report cards on screen, best match first, and says what matched.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Exactly what the user gave, e.g. \"9876543210\", \"+91 98765 43210\", \"IP07028148\", \"6159338\", \"arun kumar\", \"tindivanam\""
          },
          "date": {
            "type": "string",
            "description": "Optional discharge date YYYY-MM-DD — only if the user named one"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_discharges",
      "description": "List patients discharged on a date (optionally one department). Shows them on screen.",
      "parameters": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string",
            "description": "Discharge date YYYY-MM-DD"
          },
          "department": {
            "type": "string",
            "description": "Optional department name, e.g. PAEDIATRICS"
          }
        },
        "required": [
          "date"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "search_lab_results",
      "description": "Search stored lab results across patients. Shows a results table on screen with download and WhatsApp options.",
      "parameters": {
        "type": "object",
        "properties": {
          "test": {
            "type": "string",
            "description": "Test name words, e.g. \"urine glucose\", \"haemoglobin\", \"creatinine\""
          },
          "value": {
            "type": "string",
            "description": "Text the result must contain, e.g. \"negative\", \"positive\", \"nil\""
          },
          "status": {
            "type": "string",
            "enum": [
              "high",
              "low",
              "abnormal",
              "normal"
            ],
            "description": "Compared with the reference range"
          },
          "min": {
            "type": "number",
            "description": "Numeric result at least this"
          },
          "max": {
            "type": "number",
            "description": "Numeric result at most this"
          },
          "from": {
            "type": "string",
            "description": "Start date YYYY-MM-DD"
          },
          "to": {
            "type": "string",
            "description": "End date YYYY-MM-DD"
          },
          "date_basis": {
            "type": "string",
            "enum": [
              "discharge",
              "result"
            ],
            "description": "Whether from/to are discharge dates (default) or test result dates"
          },
          "ip_no": {
            "type": "string",
            "description": "Only this patient (IP number)"
          },
          "patient": {
            "type": "string",
            "description": "Only patients whose name contains this"
          },
          "department": {
            "type": "string",
            "description": "Only this department"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "list_lab_tests",
      "description": "List lab test names available for searching that match some words, with result counts.",
      "parameters": {
        "type": "object",
        "properties": {
          "q": {
            "type": "string",
            "description": "Words from the test name, e.g. \"glucose\""
          }
        },
        "required": [
          "q"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "app_help",
      "description": "The portal's manual: what every screen, button, badge, colour, status and tick means, how reports and WhatsApp sending work, retries, WATI usage limit, webhook, PDF links, and IT/deploy notes. Use for any question about the portal itself.",
      "parameters": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string",
            "description": "The user's question or its key words, e.g. 'red No Summary button', 'blue top line on card', '429'"
          }
        },
        "required": [
          "question"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "app_status",
      "description": "Live status of the portal: WhatsApp/WATI (Test or Live mode, test number, extra line, template, whether WATI is refusing calls and until when, API calls used today/this month, webhook, PDF links, messages today, reports waiting to retry) and the 15-minute discharge check (last run, result, next run). Shows a status card.",
      "parameters": {
        "type": "object",
        "properties": {
          "area": {
            "type": "string",
            "enum": [
              "whatsapp",
              "scheduler",
              "all"
            ],
            "description": "Default all"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "whatsapp_report",
      "description": "WhatsApp report for any dates and time of day, patient-wise and message-wise, like the WhatsApp Monitor: totals (patients, messages, sent / delivered / read / failed / pending), failure reasons, and a table on screen with Excel / PDF / CSV / JSON downloads. With ip_no, one patient's messages.",
      "parameters": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "description": "Start date YYYY-MM-DD (default today)"
          },
          "to": {
            "type": "string",
            "description": "End date YYYY-MM-DD (default = from)"
          },
          "from_time": {
            "type": "string",
            "description": "Optional start time HH:MM, 24-hour India time (10 am = 10:00)"
          },
          "to_time": {
            "type": "string",
            "description": "Optional end time HH:MM, 24-hour (2 pm = 14:00)"
          },
          "date_basis": {
            "type": "string",
            "enum": [
              "report",
              "sent"
            ],
            "description": "report (default) = patients discharged in the range (their discharge time for a time window); sent = messages sent in the range"
          },
          "view": {
            "type": "string",
            "enum": [
              "both",
              "patients",
              "messages"
            ],
            "description": "patient-wise, message-wise, or both (default)"
          },
          "status": {
            "type": "string",
            "enum": [
              "pending",
              "sent",
              "delivered",
              "read",
              "failed"
            ]
          },
          "document": {
            "type": "string",
            "enum": [
              "lab",
              "summary"
            ]
          },
          "trigger": {
            "type": "string",
            "enum": [
              "auto",
              "manual",
              "share"
            ]
          },
          "search": {
            "type": "string",
            "description": "Patient name, IP number, phone or staff name"
          },
          "ip_no": {
            "type": "string",
            "description": "One patient's IP number"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "discharge_report",
      "description": "Report of patients discharged in a date and optional time range, with filters (department, doctor, patient type, lab report / discharge summary status, WhatsApp status, search). Shows totals and a table with Excel / PDF / CSV downloads. Use for any discharge / patient report, counts or list with a time window or filters.",
      "parameters": {
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "description": "Start date YYYY-MM-DD (default today)"
          },
          "to": {
            "type": "string",
            "description": "End date YYYY-MM-DD (default = from)"
          },
          "from_time": {
            "type": "string",
            "description": "Optional discharge time from, HH:MM 24-hour"
          },
          "to_time": {
            "type": "string",
            "description": "Optional discharge time to, HH:MM 24-hour"
          },
          "department": {
            "type": "string"
          },
          "doctor": {
            "type": "string"
          },
          "patient_type": {
            "type": "string",
            "description": "General or Corporate"
          },
          "lab": {
            "type": "string",
            "enum": [
              "ready",
              "none"
            ],
            "description": "ready = has a lab report; none = no lab data"
          },
          "summary": {
            "type": "string",
            "enum": [
              "ready",
              "no_summary",
              "pending"
            ],
            "description": "no_summary = the red No Summary (EMR had no data)"
          },
          "whatsapp": {
            "type": "string",
            "enum": [
              "read",
              "delivered",
              "sent",
              "failed",
              "none",
              "nowa"
            ],
            "description": "none = not sent; nowa = not on WhatsApp"
          },
          "search": {
            "type": "string",
            "description": "Patient name, IP number, UHID or mobile"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "patient_details",
      "description": "Everything about one discharged patient: mobile / WhatsApp number, age, gender, address, city, district, relation, email, diagnosis, admission and discharge date-time, length of stay, doctor, ward, bed, patient type, reports, WhatsApp status, out-of-range lab values. Shows a details card.",
      "parameters": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Anything that identifies the patient: IP number, UHID, mobile / WhatsApp number (any format), or name"
          },
          "date": {
            "type": "string",
            "description": "Optional discharge date YYYY-MM-DD (if they had several stays)"
          }
        },
        "required": [
          "id"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "patient_journey",
      "description": "A patient's journey as a timeline / flowchart: admission, lab test days (with out-of-range values), discharge, reports made, WhatsApp sent / delivered / read, staff actions.",
      "parameters": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "Anything that identifies the patient: IP number, UHID, mobile / WhatsApp number (any format), or name"
          },
          "date": {
            "type": "string",
            "description": "Optional discharge date YYYY-MM-DD"
          }
        },
        "required": [
          "id"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "compare_patients",
      "description": "Compare two patients side by side (a and b), or one patient's lab values on two dates (only a, plus a_date / b_date; default first vs last lab day). Lab values matched test by test with the change, plus demographics for two patients.",
      "parameters": {
        "type": "object",
        "properties": {
          "a": {
            "type": "string",
            "description": "IP number, UHID, mobile number or name"
          },
          "b": {
            "type": "string",
            "description": "Second patient (leave empty to compare one patient over time)"
          },
          "a_date": {
            "type": "string",
            "description": "Optional lab result date for a, YYYY-MM-DD"
          },
          "b_date": {
            "type": "string",
            "description": "Optional lab result date for b, YYYY-MM-DD"
          }
        },
        "required": [
          "a"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "export_results",
      "description": "Make one downloadable file from numbered results of this chat (#1, #2 …): pdf, xlsx (Excel) or csv. Empty results = all of them.",
      "parameters": {
        "type": "object",
        "properties": {
          "results": {
            "type": "array",
            "items": {
              "type": "integer"
            },
            "description": "Result numbers, e.g. [1, 2]; empty for all"
          },
          "format": {
            "type": "string",
            "enum": [
              "pdf",
              "xlsx",
              "csv"
            ]
          },
          "title": {
            "type": "string",
            "description": "Optional file title"
          },
          "include_answers": {
            "type": "boolean",
            "description": "Also include each question and the answer"
          }
        },
        "required": [
          "format"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "lab_report_lookup",
      "description": "Find a patient's lab report straight in the EMR lab by UHID or IP number — including OP (out-patient) patients who aren't in the discharge data. Makes the lab report PDF and shows it with open / download / WhatsApp options. Default range: the last 30 days.",
      "parameters": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string",
            "description": "UHID (digits, e.g. 6159338) or IP number (e.g. IP07028148)"
          },
          "from": {
            "type": "string",
            "description": "Optional start date YYYY-MM-DD"
          },
          "to": {
            "type": "string",
            "description": "Optional end date YYYY-MM-DD"
          }
        },
        "required": [
          "id"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "offer_lookup_whatsapp",
      "description": "Prepare sending the lab report just looked up (lab_report_lookup) on WhatsApp to the number the user gave. Checks the number first; shows a card the user confirms with Send.",
      "parameters": {
        "type": "object",
        "properties": {
          "to_number": {
            "type": "string",
            "description": "WhatsApp number the user gave"
          }
        },
        "required": [
          "to_number"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "send_test_whatsapp",
      "description": "Send a test WhatsApp message (the user's text) to a number, through the hospital's approved template with a small test PDF. Call it with whatever the user gave; it asks for anything missing and shows a confirmation card. Use confirm: true only after the card was shown and the user said yes/send.",
      "parameters": {
        "type": "object",
        "properties": {
          "message": {
            "type": "string",
            "description": "The text to send, exactly as the user wrote it (without surrounding quotes)"
          },
          "to_number": {
            "type": "string",
            "description": "WhatsApp number, e.g. +919962460782"
          },
          "confirm": {
            "type": "boolean",
            "description": "true only when the user confirmed the card that was shown"
          }
        }
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "open_screen",
      "description": "Take the user to a screen of the portal.",
      "parameters": {
        "type": "object",
        "properties": {
          "screen": {
            "type": "string",
            "enum": [
              "discharge_reports",
              "lab_finder",
              "lab_search",
              "wati_settings",
              "whatsapp_monitor",
              "audit_log",
              "users",
              "master_settings"
            ]
          },
          "date": {
            "type": "string",
            "description": "For discharge_reports: the date to show, YYYY-MM-DD"
          },
          "filter": {
            "type": "string",
            "description": "For discharge_reports: text to filter the list by (name, IP, doctor, ward)"
          }
        },
        "required": [
          "screen"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "offer_download",
      "description": "Show a download button for the latest lab results or for one patient, in the chosen format.",
      "parameters": {
        "type": "object",
        "properties": {
          "format": {
            "type": "string",
            "enum": [
              "pdf",
              "xlsx",
              "docx",
              "csv"
            ]
          },
          "target": {
            "type": "string",
            "enum": [
              "lab_results",
              "patient"
            ],
            "description": "Latest lab results table (default) or one patient"
          },
          "ip_no": {
            "type": "string",
            "description": "For target=patient"
          },
          "date": {
            "type": "string",
            "description": "For target=patient: discharge date YYYY-MM-DD"
          }
        },
        "required": [
          "format"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "offer_whatsapp_share",
      "description": "Prepare a WhatsApp share (latest lab results PDF, or one patient's lab report + discharge summary) for the user to confirm and send.",
      "parameters": {
        "type": "object",
        "properties": {
          "target": {
            "type": "string",
            "enum": [
              "lab_results",
              "patient"
            ]
          },
          "to_number": {
            "type": "string",
            "description": "WhatsApp number the user gave, if any"
          },
          "ip_no": {
            "type": "string",
            "description": "For target=patient"
          },
          "date": {
            "type": "string",
            "description": "For target=patient: discharge date YYYY-MM-DD"
          }
        },
        "required": [
          "target"
        ]
      }
    }
  }
]
```

### 7.2 Who may use which tool

The user's permissions (if the new app has accounts; otherwise everyone gets everything):

| Tool | Needs |
|---|---|
| `find_patient`, `list_discharges`, `discharge_report`, `patient_details`, `patient_journey`, `compare_patients` | Can see discharge reports |
| `search_lab_results`, `list_lab_tests` | Can see lab values |
| `whatsapp_report` | Can see WhatsApp delivery |
| `app_status` | Can see WhatsApp delivery or WhatsApp settings |
| `app_help`, `open_screen` | Everyone |
| `offer_download` | Downloads allowed, and can see lab values or reports |
| `export_results` | Downloads allowed |
| `lab_report_lookup` | Ask AI on, can search lab by patient, OP lookup switch on |
| `offer_whatsapp_share`, `send_test_whatsapp` | Ask AI may **send** (`ai = act`) |
| `offer_lookup_whatsapp` | `ai = act`, can search lab by patient, OP lookup switch on |

Offer only the allowed tools to the model, and check each call again on the server.

### 7.3 What each tool does

All handlers return `{ forModel, block? }`.

| Tool | Behaviour | `forModel` (to the AI) | `block` (to the screen) |
|---|---|---|---|
| `find_patient` | `searchPatients(query, {date?})` (section 8), up to 20, best first. If a date was given and nothing matches, search all dates and add `note: "Not discharged on <date> — these are from other dates."` | `count, searchedFor, searchedAllDates, matchedOn, note?, patients[≤5]` (+ `matchedOn` each). If none: `hint: "Nothing in the discharge data on any date. For a UHID or IP number of an OP patient, try lab_report_lookup."` | `patients` card, title `Found N match(es) for "q" · by <match kinds>` |
| `list_discharges` | All `discharge_reports` for the date, optionally filtered by department (contains, case-insensitive) | `date, count, byDepartment, labReports, noLabData, dischargeSummaries, noSummaryRedButton, summaryNotYetAvailable` | `patients` card `N discharged on <date>` |
| `search_lab_results` | Normalise the query (section 9); needs at least one real criterion besides dates; up to 5,000 rows | `total, patients, matchedTests[≤12]`; with sharing on, `rows[≤80]` as `"<name> <ip> \| <test> = <value> (<range>) <status> \| <resultDate>"`. If none: `coverage` (first/last stored discharge date) and `similarTests[≤10]` | `labResults` card (rows ≤300) |
| `list_lab_tests` | Distinct `section › test` matching the words, by result count, ≤20 | `tests: [{name, results}]` | — |
| `app_help` | Search the manual by words: title ×3, keywords ×2, text ×1, with a stem match for words longer than 3 letters; top 2 sections | `sections: [{title, text}]`, or `note` + all topic titles | — |
| `app_status` | WhatsApp facts (section 13.6) and/or the discharge check (last run, result, next run) | `whatsapp: {...}`, `dischargeCheck: {...}` | `status` card (labelled rows with ok / warn / bad tone, link to the monitor) |
| `whatsapp_report` | Dates and time window (section 12); `basis` report (by discharge) or sent; filters; or `ip_no` for one patient's messages | `range, totals {patients, messages, sent, delivered, read, pending, failed, notOnWhatsAppNumbers}, note: "sent includes delivered and read; delivered includes read", failureReasons, shownOnScreen` | `whatsappReport` card: patient-wise and message-wise tables, downloads |
| `discharge_report` | Dates and time window; filters (department, doctor, type, lab, summary, whatsapp, search by any value). If the search finds nothing in range, search all dates | `range, totals {patients, labReady, noLabData, summaryReady, noSummary, summaryPending, whatsapp{read, delivered, sent, failed, notSent}, byDepartment}, shownOnScreen`; plus `notInThisRange` and `otherDates[]` | `dischargeReport` card (rows ≤300) with Excel / PDF / CSV |
| `patient_details` | `findRecord(id)` (section 8, best match) → all fields (section 11) | Full details (private fields removed), or only `found, ipNo, dischargeDate` if sharing is off. Not found: `hint` → lab_report_lookup | `patientDetails` card |
| `patient_journey` | Timeline (section 11) | `patient, steps[]` as `"<DD-MM-YYYY HH:mm> · <lane> · <title> — <detail>"` | `journey` card |
| `compare_patients` | Two patients, or one patient on two lab days (section 11) | `a, b, demographics, summary, labs[≤80]` as `"<test>: <a> [flag] → <b> [flag] (+diff) [range]"`, `labDays` | `compare` card |
| `export_results` | Build a file from numbered results (section 14) | `ready, file, results` | `chatExport` card |
| `lab_report_lookup` | EMR lab search by UHID or IP number (section 10) | `found, patientType, range, testDays, results, next`, or `found:false, searched, range, hint` | `labLookup` card |
| `offer_lookup_whatsapp` | Needs a looked-up report in context; checks the number (section 13.1) | `readyForConfirmation, to`, or `error: "<reason>. Ask the user for the correct number."` | `lookupShare` card (number box + Send) |
| `send_test_whatsapp` | State machine (section 13.4) | `missing: 'message' \| 'number'` + `askUser`, or `readyForConfirmation`, or `sent: true, to`, or `sent: false, error` | `testDraft` / `testMessage` card |
| `open_screen` | Portal only: navigate | `opened` | `navigate` |
| `offer_download` | Lab results list (needs `lastLabQuery`) or one patient (IP, or `lastPatient`) in pdf / xlsx / docx / csv | `ready`, or `error` | `download` card |
| `offer_whatsapp_share` | Lab results PDF, or one patient's lab report + discharge summary, to a number | `readyForConfirmation`, or `error` | `share` card (number box + Send) |

---

## 8. Finding a patient by any value (exact rules)

Implemented in `patientSearchService.js`. Copy it as is; the client filter `client/src/utils/patientMatch.js` mirrors it.

**Classify the query** (trim, collapse spaces, max 80 chars; `compact` = query without spaces, `-`, `(`, `)`, `+`, `.`):
1. `compact` matches `/^ip\d{2,}$/i` → **IP number** mode.
2. `compact` is 3+ digits → **digits** mode, with `mobile` = the 10-digit mobile (drop a leading `91` from 12 digits, or a `0` from 11).
3. Otherwise **words** mode:
   - Lower-case, non-alphanumerics become spaces; keep words of 2+ letters or containing digits.
   - Drop filler words (`mr mrs ms miss master baby dr smt thiru the patient of and`) unless nothing else is left.
   - Also keep the whole phrase.

**Score each record.** The best hit wins; no hit means no match.

| Mode | Hit | Score | "matched on" |
|---|---|---|---|
| digits | `regNo` equals | 100 | UHID |
| digits | mobile / WhatsApp / `emr.MOBILE` as 10 digits equals `mobile` | 98 | mobile number / WhatsApp number |
| digits | digits of `ipNo` equal | 96 | IP number |
| digits | a Req No equals | 90 | lab Req No |
| digits (5+) | `ipNo` digits end with it | 85 | IP number |
| digits (4+) | a phone contains it | 65 | mobile number (part) |
| digits (4+) | `regNo` contains it | 60 | UHID (part) |
| digits (4+) | `ipNo` digits contain it | 55 | IP number (part) |
| digits (4+) | a Req No contains it | 50 | lab Req No (part) |
| digits | `bedNo` equals | 30 | bed |
| IP | equal / starts with / contains the digits | 100 / 70 / 55 | IP number (…) |
| words | normalised name contains the whole phrase | 100 | name |
| words | every word is in the name | 90 | name |
| words | some words in the name, the rest in other fields | 70 | name + … |
| words | all words in other fields, one kind of field | 50 | that field |
| words | all words in other fields, several kinds | 40 | fields joined with `+` |

A word in words mode matches the name if a name part starts with it or the name contains it. Otherwise it must be found in one of these, in order:
- `name`, `emr.PATIENT NAME`
- `doctor`, `emr.DOCTOR1`, `emr.REFERRAL DOCTOR`
- `department`, `ward`, `patientType`, `createdUser`, `summaryApprovedBy`
- `emr.RELATION NAME`, `emr.ADDRESS`, `emr.AREA / VILLAGE`, `emr.City`, `emr.District`, `emr.EMAIL`, `emr.E-MAIL`
- `ipNo`, `regNo`

A digit word (3+ digits) inside a words query uses the digit rules.

**Query MongoDB with a loose filter, then score:**
- Phone digits match with anything in between (regex `9\D*8\D*7…`, anchored at the end for a full mobile).
- Fetch up to 500 newest records (`date` desc), score them, sort by score then date, and return the top 20 (or `limit`). Optional `date` (one day) or `from` / `to`.
- Each result carries `match: {score, on}`.

---

## 9. Lab values: search and flags

**Search query** (`normaliseQuery`):
- `test`, `value`, `ipNo`, `regNo`, `patient` and `department` are trimmed to ≤80 chars.
- `from` / `to` must be `YYYY-MM-DD`; `status` is one of `high low normal abnormal`; `min` / `max` are finite numbers.
- `dateBasis` = `result` (by `resultDay`) or `discharge` (default, by `dischargeDate`).
- **At least one criterion besides dates is required.**

**Filter rules:**
- `test`: every word must appear in `searchText` (any order).
- `value`: contains, case-insensitive.
- `ipNo`: exact, case-insensitive. `patient` and `department`: contains.
- `abnormal` = `high` or `low`. `min` / `max` apply to `numeric`.
- Sort: discharge date desc, name, test, result day.

**Flag** (`getStatusColor`, the same as the PDF's H / L):
- Take the number from the value after removing `< > =` and spaces. Not a number → no flag.
- Range `a - b`: below a → **low**; above b → **high**; otherwise **normal**.
- Range `> a`: ≤ a → **low**, else **normal**.
- Range `< a`, `upto a` or `up to a`: > a → **high**, else **normal**.

**How to read the user's words** (prompt rule): qualitative results (negative, positive, nil, trace, reactive) go in `value`; "high" / "low" / "abnormal" go in `status`; numbers go in `min` / `max`. If unsure of the test name, or nothing is found, call `list_lab_tests` and ask which test.

---

## 10. OP / any-UHID lab report (EMR lookup)

- **Input:** a UHID (digits) or an IP number. Clean it (no spaces, upper case); it must match `^(IP)?\d{4,12}$`, otherwise: "Ask for a UHID (digits) or an IP number".
- **Range:** default the last `ai.lookupDays` days (30) up to today in IST; up to **1 year**. "last 6 months" or explicit dates widen it.
- **Search:** run the EMR lab history (4.4) and build the chart. No lab days means not found: "Nothing in the EMR lab for this number in that range — offer a wider range (up to a year) or check the number."
- **Found:**
  - Render the lab chart PDF with the letterhead (subtitle `Laboratory investigation chart · <range>`; IP shown as `OP` for out-patients).
  - Store it at `lookups/<today>/<12hex>.pdf`.
  - Return `{lookupId, day, id, from, to, patient {name, age, sex, ipNo, uhid, unit, type: 'OP'|'IP'}, dates, firstDate, lastDate, tests, fileName}`.
- **Card:** Open PDF, Download PDF (the patient's own PDF, allowed even when list downloads are off), WhatsApp (if the user may send), and the note "OP patients appear only here in Ask AI — not in Discharge Reports."
- **Send** (`POST /api/assistant/lookup/:day/:id/whatsapp`, `{toNumber, name, patientId}`):
  - Check the number (13.1), then send with the **Ask AI lab template** (WATI Settings `labReportTemplate`, default `mapims_lab_rpt`).
  - Log `trigger: 'share', via: 'assistant', document: 'other', documentLabel: 'Lab Report (Ask AI)', uhid`.
  - Return `{sentTo: '+91 98765 43210', messageId, template}`, then poll the status (13.5).
- **Never** add a lookup to `discharge_reports`, `lab_results` or any list.

---

## 11. Patient details, journey and compare

**Details** (`patientDetails`):
- **Fields:** take the best record by any value, fill `emr` from the EMR discharge row if missing (cached 10 min per date), then build the field list:
  - Core fields in order: Name, IP No, UHID, Age, Gender, Mobile, WhatsApp No, Patient type, Department, Doctor, Ward, Bed, Admitted, Discharged, Length of stay, Discharge type, Created by, Summary approved by.
  - Then every other `emr` column, except those already shown and `IPVISIT`.
- **Length of stay:** discharge minus admission (EMR times are IST) → `"3 days 4 h"` or `"20 h"`.
- **Reports:** "Ready (N lab days)" / "No lab data"; summary "Ready" / "No Summary (EMR had no data)" / "Not available yet".
- **WhatsApp:** latest message per document → status ("Not on WhatsApp" for that failure), to, sent at, read at.
- **Labs:** count, days, out-of-range values (≤25 shown) and total. Other stays of the same patient are listed too.
- **To the AI:** everything except `ABHA ID`, `RELIGION`, `MLC`, `MLC RECORD NUMBER`.

**Journey** (`patientJourney`): dated steps `{at, lane, title, detail, tone}` sorted by time.
- `stay` — Admitted (department, ward, bed, diagnosis)
- `lab` — one step per result day at 09:00: "Lab tests · N results" with "Out of range: X ↑ v, …" (≤6, then "+n more"), tone warn, or "All within range"
- `stay` — Discharged (type, stay length, doctor)
- `reports` — Lab report made; Discharge summary ready / "no data in EMR"
- `whatsapp` — each message: sent (to, automatically / by user), delivered, read by patient, or failed (reason)
- `staff` — staff actions from the audit log (PDF opened, WhatsApp popup opened / cancelled), ≤30

**Compare** (`comparePatients`):
- **Two patients:** each one's latest value per test (optionally for a given result day), plus demographics side by side (UHID, age / gender, department, doctor, admitted, discharged, length of stay, diagnosis, discharge type).
- **One patient:** first vs last lab day by default (or `a_date` / `b_date`).
- **Rows:** `{test, section, range, a{value, flag, date}, b{…}, diff (numeric b − a, 2 decimals), changed}`, with tests present in both first.
- **Summary:** `testsCompared, changed, abnormalA, abnormalB, onlyA, onlyB`.

---

## 12. Reports: dates and time windows

`reportDates(args)`:
- `from` defaults to today (IST) and `to` to `from`; swap them if reversed.
- Times are accepted as `"10:00"`, `"10"`, `"10am"`, `"2 pm"`, `"14:30"` or `"9.30 a.m."` and become `HH:MM` (24 h).
- If only one time is given, the other is `00:00` or `23:59`.
- **Overnight:** one date with from-time later than to-time (e.g. 20:00 → 08:00) starts **the evening before**.

**Prompt phrases to handle:**
- "today 10 am to 2 pm" = today with 10:00–14:00.
- "yesterday evening" = 16:00–20:00.
- WhatsApp reports count **patients by discharge date / time** unless the user says "sent" (`date_basis: sent`).
- "patient and message wise" = `view: both`.

**Time window filters:**
- A discharge report keeps patients whose **discharge time** (EMR `DISCHARGE DATE` text, IST) is in the window.
- A WhatsApp report by report basis does the same by discharge time; by sent basis, by send time.

---

## 13. WhatsApp (WATI)

### 13.1 Checking a number someone typed (`checkWhatsAppNumber`)

- Keep digits only. Empty → "Enter the WhatsApp number".
- Local number: drop `91` from 12 digits, or `0` from 11.
- Fewer than 10 digits → "That number has only N digits — please enter the full 10-digit mobile number" (singular for 1).
- 10 digits:
  - Must start with 6–9, else "Indian mobile numbers start with 6, 7, 8 or 9 — please check the number".
  - OK → `91` + number.
- 11–15 digits not starting with `91` → another country, OK as is.
- Anything else → "That number has N digits — please check it (10-digit mobile, with or without +91)".

Show numbers as `+91 98765 43210`. The browser runs the same check while typing, for instant feedback.

### 13.2 Templates (all approved, each with a per-message PDF header)

| Template | Parameters |
|---|---|
| `investigation` (default, `WATI_TEMPLATE_ID`) | `1` = name, `2` = one line (`Attached: Lab Report` or `Attached: Discharge Summary`, plus ` — <extra line>` if set), `3` = PDF URL |
| `investigation_report` | `1` = name, `3` = PDF URL |
| `mapims_lab_rpt` (Ask AI lab lookups, "Your laboratory report is ready") | `1` = name, `attachmentLink` = PDF URL |

Template parameters cannot contain line breaks. Each document is its own message, since a template has one document header. The test message uses `investigation` with `1 = "Sir/Madam"` and `2` = the user's text.

### 13.3 Sending

`POST {API_ENDPOINT}/api/v1/sendTemplateMessage?whatsappNumber=<digits>`

**Headers:**
- `Authorization: <WATI_ACCESS_TOKEN>` — the full `Bearer …` value
- `Content-Type: application/json-patch+json`
- `Accept: application/json`
- **a browser-like `User-Agent`** — without it WATI's Cloudflare blocks the call with 403 / 1010

**Body and timeout:** `{ "template_name": "<t>", "broadcast_name": "<t>_<digits>_<timestamp>", "parameters": [{ "name": "1", "value": "…" }, …] }`, 20-second timeout.

**Outcome:**
- **HTTP 429** = WATI's monthly API quota is used up (it covers sends and status reads). Mark the failure "WATI API usage limit exceeded (429) — will retry later" and pause automatic sends (1 h, then 3 h, then 6 h).
- Success needs `result === true`. Then:
  - `validWhatsAppNumber === false` → failure "+<digits> is not a WhatsApp number" (`notOnWhatsApp`).
  - Otherwise `status: sent`, `acceptedAt`, and store `watiSendIds` from `model.ids`, `localMessageId` and `id` so webhooks can match the message.

**PDF links:** with `PUBLIC_BASE_URL` set, `{PUBLIC_BASE_URL}/api/public/doc/<token>/<FileName>.pdf`:
- **Token:** base64url `{k: objectKey, e: expirySeconds}` + `.` + HMAC-SHA256 (key `PUBLIC_LINK_SECRET`), valid `WHATSAPP_LINK_DAYS` (default 2) days.
- **The route:** streams the PDF inline. An expired link shows "This link has expired. Please ask the hospital to send the report again."
- **Without `PUBLIC_BASE_URL`:** a MinIO presigned URL.
- **File names:** WhatsApp shows them, e.g. `Lab-Report-6159338.pdf`.

### 13.4 Test message (state machine)

`send_test_whatsapp({message?, to_number?, confirm?})`:
- **Message:** collapsed whitespace, quotes stripped, ≤300 chars. If missing, use the stored draft.
- **Number** (`cleanTestNumber`): `91[6-9]\d{9}`, or 11–15 digits not starting with 0 or 91.
- **Steps:**
  1. No message → `{missing:'message', askUser:'What message should I send?'}`.
  2. Message but no number → `{missing:'number', message, askUser:'Which WhatsApp number should I send it to?'}` plus a `testDraft` card (the browser remembers the text).
  3. Both, not confirmed → `{readyForConfirmation, message, to}` plus a `testMessage` card with status `ready` (the browser keeps `pendingTest`). The user presses **Send**, or types **yes / ok / send / sure / go ahead …**.
  4. `confirm: true` **and** the same message and number as `pendingTest` → send it now:
     - Build a one-page "WhatsApp Test Message" PDF (letterhead, message, sent to, sent by, time, and "contains no patient information").
     - Send it through the template and log `documentLabel: 'Test message'`.
     - Result: `sent: true` / card `sent`, or `sent: false, error` / card `failed` with "Try again".
- **Cancel:** "cancel / stop / never mind / no / don't send" while a draft or card is pending → "Okay, cancelled — nothing was sent." (handled before the model), and the browser clears the draft.

### 13.5 Following one message

`POST /api/assistant/message/:id/status {check}` returns `{status, notOnWhatsApp, error, reason, toNumber, sentAt, deliveredAt, readAt}`.

**Polling and "Check with WATI":**
- The card polls the stored state every **15 s, 20 times** (about 5 min).
- **"Check with WATI"** asks WATI once (at most every 30 s per message, never while WATI is paused):
  - `GET /api/v1/getMessages/<number>`, then match the message.
  - Map `statusString`: SENT → sent, DELIVERED → delivered, READ / REPLIED → read, FAILED → failed (+ `failedDetail`).

**Card text per state:**

| State | Text |
|---|---|
| `pending` | "Sending…" |
| `sent` | "Sent ✓ — WhatsApp hasn't confirmed delivery yet" (after a check: "WATI has no delivery tick yet — the phone may be off or offline.") |
| `delivered` | "Delivered ✓✓ — not read yet" |
| `read` | "Read" with a check mark |
| `failed`, not on WhatsApp | "This number is not on WhatsApp — please check the number and try another." |
| `failed`, other | "Not delivered: <reason> (<error>)" |

**Webhooks** (portal, or the new app in option B): `POST /api/public/wati-webhook/<WATI_WEBHOOK_KEY>`.
- **Event types:** `templateMessageSent*` → sent, `sentMessageDELIVERED*` → delivered, `sentMessageREAD*` / `REPLIED` → read, `templateMessageFailed*` / `*failed*` → failed.
- **Matching:** by `whatsappMessageId`, `localMessageId` or `id` against stored ids. Otherwise by `waId` plus a pending / sent record from the 15 minutes before.
- **Ordering:** never move a status backwards.

### 13.6 Live WhatsApp facts for `app_status`

The model gets:
- **Mode:** `watiConfigured`, `mode` (Live / Test text), `liveMode`, `extraLine`, `template`.
- **`watiApi`, one of:**
  - `REFUSING calls — WATI API usage limit (429) since <time>. Refused reports are re-sent automatically.`
  - `Accepting calls — the latest call went through at <time>` (a successful call within 6 h)
  - `UNKNOWN — this app has made no WATI calls in the last few hours, so it cannot tell whether WATI is accepting. Do not say WhatsApp is working.`
- **Usage and timing:** `callsRefusedToday`, `pausedUntil`, `lastUsageLimitAt`, `refusedByUsageLimitLast24h`, `apiCallsToday`, `apiCallsThisMonth`.
- **Updates and links:** `statusUpdates` (webhook / status checks / off), `lastWebhookEvent`, `lastStatusCheck`, `pdfLinks`.
- **Today and retries:** `messagesToday {pending, sent, delivered, read, failed, total}`, `waitingForAutomaticRetry`, `nextRetryAt`.

**Background the manual must explain** (copy from `appGuide.js`):
- WATI's monthly quota covers sends **and** status reads; the Growth plan has 10,000 a month, reset on the 1st, shared with the EMR's own messages.
- Test mode sends nothing automatically, and manual sends go to the test number.
- Retries: every 6 h for 3 days, plus one 15-minute quick retry for plain failures.
- "Not on WhatsApp" is sometimes wrong (phone off or out of data), so it is retried too.

**Failure reasons** (`failureCategory`):

| Reason | When |
|---|---|
| Not on WhatsApp | The `notOnWhatsApp` flag or text |
| WATI usage limit | 429 / usage limit |
| Network / WATI busy | timeout, aborted, network, ECONN, socket, 502/503/504, busy, rate limit |
| Template rejected | template |
| Report missing | no longer available, no patient data, pdf |
| WhatsApp would not deliver | undeliverable, 131026, 131047, blocked, re-engage, 24 hours |
| Other | anything else |

---

## 14. Numbered results and files from the chat

**Numbering:**
- **Numbered card types:** `patients, labResults, whatsappReport, dischargeReport, status, labLookup` (found only), `patientDetails, journey, compare`.
- **Each new card:** gets `n = last n + 1` for the `chatId` (one id per conversation; "New chat" makes a new one) and is stored in `assistant_results` with a title. Every reply's question and answer is stored too.
- **Display:** the UI shows a `#n` badge on each numbered card.

**Card titles:**
- `patients`: the card title
- `labResults`: `Lab results · <total> results, <patients> patients`
- `labLookup`: `Lab report · <name or id>`
- others: their title

**`export_results({results, format, title?, include_answers?})`**: `results` empty = all. The file has one or more tables per result:

| Result | Tables |
|---|---|
| `patients` | Patient, IP No, UHID, Age / sex, Department, Doctor, Discharged |
| `labResults` | Patient, IP No, Test (section), Result, Range, Flag, Result date, Discharged |
| `dischargeReport` | Patient, IP No, UHID, Department, Doctor, Discharged, Lab report, Summary, WhatsApp |
| `whatsappReport` | Patient-wise (Patient, IP No, Department, Discharged, Overall, Lab report, Summary) and message-wise (Patient, IP No, Document, Status, Sent, Why it failed) |
| `status` | Item, Value, per section |
| `labLookup` | UHID / IP, type, age / sex, unit, results |
| `patientDetails` | Detail, Value; plus out-of-range values; plus WhatsApp |
| `journey` | When, Stage, What, Details |
| `compare` | Patients (if two), and lab values with the change |

**Formats:**
- **pdf:** hospital letterhead; each table with a heading; optional Q&A section.
- **xlsx:** one sheet per table.
- **csv:** sections one after another.

**Storage:** `chat-exports/<day>/<id>.<ext>`; downloaded via `GET /api/assistant/export/:day/:id.:ext?name=<file name>` (`&download=1` forces a download).

**Prompt rule:** several files = several calls ("#1 and #2 as one PDF, #3 as CSV"). "Everything in one PDF" = all results, pdf.

---

## 15. Context: browser ↔ server

**The browser keeps `context`** and sends it with every question:

| Key | Set when the reply contains | Cleared when |
|---|---|---|
| `lastLabQuery` | a `labResults` card (its normalised query) | New chat |
| `lastPatient {ipNo, date}` | a `patients` card with exactly one patient | New chat |
| `lastLookup {day, lookupId, id, name}` | a found `labLookup` | New chat |
| `testDraft {message}` | a `testDraft` card with a message | a `testDraft` card with `message: null` (cancel), or a `testMessage` card |
| `pendingTest {message, toNumber}` | a `testMessage` card with status `ready` | the card is sent or cancelled, or another `testMessage` arrives |
| `view` | (portal only) the current screen | — |

**The server never trusts it:**
- `lastLookup` needs a `YYYY-MM-DD` `day` and a 12-hex `lookupId`.
- `lastPatient` needs an alphanumeric `ipNo` and a valid date.
- Test text and numbers are cleaned again.
- `lastLabQuery` is normalised again and dropped if it has no real criterion.

**Request:** `POST /api/assistant` with `{messages: [{role, content}], context, chatId}`.
- `chatId` = `c` + base36 time + 4 random chars (must match `^[a-z0-9]{6,40}$`).
- `messages` is the visible chat (the user's last message included). The input is limited to 600 chars.

**Response:** `{ok: true, reply, blocks: [...], fallback?}`, or `{ok: false, error}` with HTTP 502 → the bubble shows "Sorry, I couldn't answer that: <error>".

---

## 16. Cards (`blocks`)

Every card shows real data from the tools. Render them below the assistant's reply bubble, in order, with a `#n` badge if numbered.

| Type | Fields | Renders |
|---|---|---|
| `patients` | `title, patients[{date, ipNo, regNo, name, age, gender, patientType, department, doctor, ward, dateCount, hasSummary, summaryDataMissing, summaryApprovedBy}]` | One row per patient (first 4, "Show all N"): name, DD-MM-YYYY, IP, UHID, department; per patient: **Lab Report PDF** (if `dateCount` exists), **Summary PDF** (if `hasSummary` and not missing), Excel / Word / CSV of their lab values, **WhatsApp** (number box → Send, if allowed) |
| `labResults` | `query, total, patients, matchedTests, truncated, rows[]` | Count line, matched tests, table (patient, IP, test, result, range, flag), downloads PDF / Excel / Word / CSV, WhatsApp share; empty → "No matching lab results found." |
| `dischargeReport` | `title, query, totals, rows[], total` | Totals chips, department breakdown, table, downloads Excel / PDF / CSV |
| `whatsappReport` | `title, query, view, totals, patients[], messages[], patientsTotal, messagesTotal` | Totals, Patients / Messages tabs, status pills (Not on WhatsApp in dark red), downloads Excel / PDF / CSV / JSON |
| `status` | `title, sections[{title, rows[{label, value, tone}], link}]` | Labelled rows with ok / warn / bad colour |
| `patientDetails` | `record, fields[{label, value}], stay, reports, whatsapp[], labs{results, days, abnormal[], abnormalTotal}, otherStays[]` | Field grid, report status, WhatsApp list, out-of-range values |
| `journey` | `record, steps[{at, lane, title, detail, tone}]` | Vertical timeline / flowchart grouped by lane colour |
| `compare` | `labelA, labelB, demographics[], labs[], summary, days?` | Side-by-side table, ↑ / ↓ change, out-of-range highlighted |
| `labLookup` | `found, lookupId, day, id, from, to, range, patient, dates, firstDate, lastDate, tests, fileName` | Patient line, "N results · D days (first – last) · searched <range>", Open PDF, Download PDF, WhatsApp (number box → Send → live status), OP note; not found → message with the range |
| `lookupShare` | `lookup, toNumber, display` | The number pre-filled, Send, then live status (13.5) |
| `testDraft` | `message` (or `null` = cancel) | Nothing visible; updates context |
| `testMessage` | `status: ready\|sent\|failed, message, toNumber, display, error?` | "Test message to +91 …", the text in a bubble, "Sent with the report template and a small test PDF.", Send / Cancel → Sending… → "Sent — WATI accepted it. Check that phone." or "Not sent: <error>" + Try again |
| `download` | `target: lab_results\|patient, format, query\|patient` | One download button |
| `share` | `target, toNumber, query\|patient` | Number box (pre-filled) and Send; on success "Sent on WhatsApp to <number>" |
| `chatExport` | `filename, format, results[], size, day, id` | File chip: Open (pdf), Download |
| `navigate` | `view, date?, filter?` | "Opened <screen>" (portal), or a link to the portal |

**The "WhatsApp" send buttons on cards call:**
- `POST /api/reports/:date/:ip/share {toNumber, via:'assistant'}` — patient: lab report + summary
- `POST /api/lab-results/share {query, toNumber, via}` — results PDF
- `POST /api/assistant/lookup/:day/:id/whatsapp` — lookup

All of them check the number first.

---

## 17. Rule-based fallback (no AI model available)

Same tools, no model. Evaluate in this order and return at the first match. `busyNote` = "The AI helper is busy right now, so I ran a direct search."

| # | Condition | Action and reply |
|---|---|---|
| 1 | "cancel / stop / never mind / no" with a pending test | "Okay, cancelled — nothing was sent." |
| 2 | `pendingTest` and "yes / y / ok / okay / send / send it / confirm / go / go ahead / proceed / sure / do it" | `send_test_whatsapp` with `confirm: true` |
| 3 | The last assistant message asked "What message should I send?" | Treat the text (or the "quoted" part) as the message, plus any phone in it |
| 4 | `testDraft` and a phone number in the text | Number for the draft |
| 5 | "send / test … message", "test whatsapp" (not about an IP, not a why / status question) | `send_test_whatsapp` with the quoted text and the number |
| 6 | A looked-up report, any 8–17 digit number, not a status question | `offer_lookup_whatsapp` → "Check the number +91 …, then press Send." or the number error |
| 7 | "send / share / forward" with a lab list, a patient or an IP | `offer_whatsapp_share` → "Check the number, then press Send." |
| 8 | A format word (pdf, excel, xlsx, xls, spreadsheet, word, docx, doc, csv) with download / export / as / file / get, and a target | `offer_download` → "Your download is below." |
| 9 | A file format and earlier results, mentioning #n / all / result / everything / above / these / those / combine / group / single / first / last / both | `export_results`; "#1 and #2 in a PDF and the rest in a CSV" makes two files; "first two" = the first 2 results; "answer / question / chat" adds the Q&A |
| 10 | An id and "journey / flowchart / timeline / what happened" | `patient_journey` |
| 11 | "compare / versus / vs / difference / changed" with 1–2 ids | `compare_patients` → "Compared N lab tests — X changed; out of range: a in the first, b in the second." |
| 12 | An id (IP, UHID, or a phone number when other details are asked) with detail words | `patient_details`, answering each asked field: "WhatsApp No", "Mobile", "Age", "Gender", "ADDRESS", "City" (or District / State / AREA / VILLAGE), "Discharged", "Admitted", "Length of stay", "IP_Diagnosis", "Doctor", "Ward" + "Bed", "EMAIL", "RELATION NAME" → "`<id> — Age: … · Discharged: …`. All details are below." |
| 13 | IP and WhatsApp words | `whatsapp_report` for that IP → "IP…: N patients, M messages — r read, d delivered, s sent, f failed. Failed because: …" |
| 14 | A time window or report / wise / list / export / count words, about WhatsApp | `whatsapp_report` (status failed / pending from the words; sent basis if "sent" and not "discharge"; view from "patient wise" / "message wise") |
| 15 | The same, about discharges / patients (not lab words) | `discharge_report` → "`<range>`: N patients — x lab reports, y summaries, z No Summary." |
| 16 | WhatsApp words with a status / today / mode / live / test question | `app_status` (whatsapp) → a Live / Test explanation, REFUSING note, today's counts, retry queue |
| 17 | "schedule / cron / next check / last check / discharge check / sync / automation" | `app_status` (scheduler) |
| 18 | A phone number (no send words) | `find_patient` by phone → "Found N patients with … (matched on …)" or "No discharged patient has the number … on any date. If they're an OP patient, give me their UHID and I'll check the EMR lab." |
| 19 | "find / search / look up / who is / named / called / details of" + a name or place | `find_patient` by that text |
| 20 | An IP or UHID (or 6–9 digits with find / lab / report words) | `find_patient`; nothing → `lab_report_lookup` (if allowed) |
| 21 | "discharge" + a date ("today", "yesterday", DD-MM-YYYY …) | `list_discharges` |
| 22 | A how / what / why / where / help / explain question or "…mean" (not a lab question) | The best manual section (score ≥3) shown as `**Title**\ntext`, else the HOW_TO steps |
| 23 | Test words / values / flags | `search_lab_results` |
| 24 | Nothing matched | "The AI helper is busy right now. Try a direct question like "IP07028148 lab report", "discharges on <yesterday>" or "urine glucose negative last week"." |

**Date words in the fallback:**
- `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`, today, yesterday.
- "last / past week" = the last 7 days; "last / past / this month" = the last 30 days.

**Time windows in the fallback:**
- Recognised forms: "10am to 2pm", "10:00-14:00", "10 to 2 pm", "from 9.30 am till 1 pm".
- A bare "3 to 5" is not a time.

---

## 18. Privacy and safety

- **Privacy switch** `ai.sharePatientData` (env `AI_SHARE_PATIENT_DATA`, default on):
  - **On:** tool results go to the AI provider with patient data, so it can answer "her number", "discharge time", "compare".
  - **Off:** the AI gets counts and ids only; cards still show everything on screen.
- **Never sent to the provider:** `ABHA ID`, `RELIGION`, `MLC`, `MLC RECORD NUMBER`.
- **No real patient data in prompts or examples.** Examples use made-up values (Baby Arun Kumar, IP07000123, 98765 43210).
- **Sending needs a person:** nothing goes out on WhatsApp without a Send press or a "yes" to that exact card. Number checks happen on the server too.
- **Logging:** every send is logged in `whatsapp_messages` with who triggered it; every question and answer is stored with its `chatId` (2 days) and, with the portal, in the audit log.
- **Limits:** messages ≤600 chars in the UI and ≤2,000 to the model; tool string arguments are cut (60–80 chars); regex input is always escaped.
- **Footer** under the chat: "AI can misread questions — check results before acting on them."

---

## 19. Permissions (if the new app has user accounts)

Use the portal's model, or a simpler one with the same effect:
- **`ai`**: `none` / `ask` (questions only) / `act` (may prepare and send WhatsApp).
- **What data:** discharge reports, lab values, WhatsApp delivery, WhatsApp settings / status.
- **`documents`**: both / lab only / summary only (hide the other PDF and its send).
- **Switches:** downloads on / off; EMR OP lookup on / off.
- **Super admin** gets everything.

Every rule is also checked on the server, not just hidden in the UI.

---

## 20. HTTP API (what the chat UI calls)

| Method and path | Purpose |
|---|---|
| `POST /api/assistant` | Ask (section 15) |
| `GET /api/reports/:date/:ip/pdf`, `GET /api/reports/:date/:ip/summary-pdf` | A patient's lab report / discharge summary PDF (presigned redirect or stream) |
| `POST /api/reports/:date/:ip/share` | Send the patient's PDFs on WhatsApp (`{toNumber, via}`) |
| `POST /api/lab-results/export` | Lab values as pdf / xlsx / docx / csv (`{query, format}`) |
| `POST /api/lab-results/share` | Lab results PDF on WhatsApp |
| `GET /api/discharges/export?…&format=` | Discharge report file |
| `GET /api/admin/whatsapp/export?…&format=&view=` | WhatsApp report file |
| `GET /api/assistant/lookup/:day/:id.pdf?name=&download=1` | Lookup PDF |
| `POST /api/assistant/lookup/:day/:id/whatsapp` | Send the lookup PDF |
| `POST /api/assistant/message/:id/status` | One message's status (`{check}`) |
| `POST /api/assistant/test-whatsapp` | Send the confirmed test message (`{message, toNumber}`) |
| `GET /api/assistant/export/:day/:id.:ext?name=&download=1` | Chat export file |
| `GET /api/public/doc/:token/:filename` | **Public**, signed and expiring PDF link for WhatsApp |
| `POST /api/public/wati-webhook/:key` | **Public**, WATI status events (option B only) |

Everything except `/api/public/*` needs a signed-in session (an HMAC cookie with user, token version and expiry; 12 h).

---

## 21. Chat UI

**Layout:**
- **Launcher:** a floating **"Ask AI"** button (sparkles icon), bottom right.
- **Panel:** a right-side card, about 420 px wide, full height on phones.
- **Header:** icon, **"Ask AI"**, subtitle "Reports, lab results, WhatsApp status and how-tos". Buttons: **New chat** (shown once there are messages; clears messages and context and makes a new `chatId`) and **Close**.

**Empty state:** "How can I help?" with "Ask for a patient's reports, find patients by lab result, check whether WhatsApp is working, or ask what anything on screen means." Then these suggestion chips (hide the test one for `ai ≠ act`):
- "Show today's discharges"
- "Patients with urine glucose negative last week"
- "Is WhatsApp working right now?"
- "Today's WhatsApp report, patient and message wise"
- "Patients discharged today 10 am to 2 pm"
- "What does the red No Summary button mean?"
- "Send a test WhatsApp message"

**Messages:**
- User bubbles on the right; assistant bubbles on the left. `**bold**` in the reply renders as bold; everything else is plain text.
- Cards follow the reply. A typing indicator (three dots) shows while waiting. The list auto-scrolls.

**Input:**
- Textarea; Enter sends, Shift+Enter adds a new line; 600 chars max.
- Placeholder "e.g. IP07028148 lab report"; Send button.

**Below the input:** "AI can misread questions — check results before acting on them."

---

## 22. Built-in manual (`app_help`)

Copy the sections of `server/src/services/appGuide.js` that describe the process, not the portal's screens. Each section has `{id, title, keywords, text}`; some texts are getters that read live settings.

**Keep:**

| Id | Topic |
|---|---|
| `overview` | Adapt it |
| `lab-report-pdf`, `summary-pdf` | What the PDFs contain |
| `whatsapp-template` | |
| `whatsapp-statuses` | Ticks, delivered, read |
| `auto-send` | |
| `retries` | |
| `wati-quota` | 429 |
| `plugin-not-supported` | WATI inbox preview |
| `pdf-links` | |
| `webhook` | |
| `not-on-whatsapp` | |
| `no-lab-data` | |
| `op-lookup` | |
| `test-message` | |
| `ai-reports` | |
| `ai-patient-answers` | |
| `exports` | |

**Write new sections** for this app's own screen: the chat, cards, numbered results and the New chat button.

**Search:** words minus stop-words; title ×3, keywords ×2, text ×1; stem match for words longer than 3 letters; return the top 2 sections.

---

## 23. Acceptance tests (must pass before go-live)

Run these against real data. Use **only made-up or your own numbers** for anything that can send. A guard test must use input that **cannot** reach WATI even if the guard is broken (a 9-digit number, a non-existent patient).

| # | User says | Must happen |
|---|---|---|
| 1 | "find the patient by this phone number 9876543210" (a real patient's number, discharged on an earlier day) | `find_patient` with that text → the patient found across dates; reply names them and says the mobile number matched |
| 2 | "who has mobile +91 98765 43210?" | Same patient (spaces and +91 ignored) |
| 3 | "age and discharge time of the patient with number 9876543210" | `patient_details` → reply gives the age **and** the discharge time (e.g. "47 years old, discharged 02-10-2026 at 10:39 AM") |
| 4 | "IP07028148 lab report" | `find_patient` → card with Lab Report PDF / Summary PDF / WhatsApp |
| 5 | A UHID of an OP patient: "lab report of 6159338" | `find_patient` finds nothing → `lab_report_lookup` → PDF card; reply says it's from the EMR lab and OP patients appear only in the chat |
| 6 | then "send it to 98765 4321" (9 digits) | "That number has only 9 digits — please enter the full 10-digit mobile number"; no card with Send |
| 7 | "patients with urine glucose negative last week" | `search_lab_results` `{test:"urine glucose", value:"negative", from, to}` → table and count |
| 8 | "haemoglobin below 8 in September" | `{test:"haemoglobin", max:8, from:"<YYYY>-09-01", to:"<YYYY>-09-30"}` |
| 9 | "patients discharged today 10 am to 2 pm" | `discharge_report` `{from: today, from_time:"10:00", to_time:"14:00"}` → totals sentence |
| 10 | "today's WhatsApp report patient and message wise" | `whatsapp_report` `{view:"both"}` |
| 11 | "is WhatsApp working?" (no WATI call in 6 h) | Says it **isn't known yet** — never "working" |
| 12 | "what does the red No Summary button mean?" | `app_help` → answer from the manual only |
| 13 | "send a test message" → "hello" → "+91 98765 43210" | Asks for the message, then the number, then shows the card; nothing is sent until Send / "yes" |
| 14 | "cancel" while the card waits | "Okay, cancelled — nothing was sent." |
| 15 | After 3 results: "put #1 and #2 in one PDF and the rest in a CSV" | Two files: PDF (#1, #2) and CSV (#3) |
| 16 | "journey of IP07028148" | Timeline card; reply in order with dates and times |
| 17 | "compare the first and last lab day of IP07028148" | `compare_patients` `{a:"IP07028148"}` → main rises and falls with numbers |
| 18 | A question in Tamil | Reply in Tamil |
| 19 | With the AI provider keys removed: "IP07028148 lab report" | The fallback answers with the same card ("The AI helper is busy right now, so I ran a direct search. …") |
| 20 | A user without send rights: "send this to 98765 43210" | No share card; reply says their account can't send |

---

## 24. Environment

See **`AI_FOR_AOSTRA.env.example`**. Copy it to the new app as `.env` and fill in the values from the portal's `server/.env` on the server. **Never commit the filled file.**

**Three values are new in the standalone app.** In the portal they are screen settings, not env:

| Variable | Default | Portal equivalent |
|---|---|---|
| `AI_LOOKUP_DAYS` | `30` | Master Settings → Ask AI → "EMR lab lookup searches back" |
| `DISCHARGE_CHECK_MINUTES` | `15` | Master Settings → Discharge automation → "Check every" |
| `WATI_LAB_REPORT_TEMPLATE` | `mapims_lab_rpt` | WATI Settings → "Template for Ask AI lab reports" |

**`PUBLIC_LINK_SECRET` must be identical in both apps.** Otherwise WhatsApp PDF links made by one app won't open through the other.

---

## 25. Build checklist

1. Same stack; Docker Compose with the new app on the portal's network (option A). Mongo and MinIO stay unpublished, reached through the internal network.
2. Copy these services as they are, then remove anything that imports portal-only screens or settings:
   - `patientSearchService`, `labResultsService` (search half), `patientInsightService`, `chatResultsService`
   - `labLookupService`, `emrService`, `investigationPdfService` (`buildInvestigationChartHtml`, `renderHtmlToPdf`, `flattenChartResults`, `getStatusColor`)
   - `pdfBranding`, `watiService`, `whatsappTestService`, `publicLinkService`, `storageService`, `mongo`
   - the parts of `whatsappLogService` used by `logSendStart`, `logSendResult`, `checkMessageStatus`, `messageState`, `failureCategory`, `whatsappReportData`, `whatsappSummary`
   - `dischargeReportQuery`
3. Port `assistantService.js` with the four prompt edits (section 6) and without `open_screen` (or keep it as a portal link).
4. Build the UI from `AssistantPanel.jsx` and `ExportShareBar.jsx` as a full page (the chat in the centre and suggestions in the empty state), not a pop-over.
5. Point the **public PDF link** at a reachable https address (`PUBLIC_BASE_URL`), and use the **same `PUBLIC_LINK_SECRET` as the portal** so links made by either app work.
6. Run the acceptance tests (section 23).

---

## 26. Report templates (Lab Report and Discharge Summary)

The folder **`templates/`** holds both documents exactly as the portal makes them, rendered by the portal's own code with a **made-up patient** (Baby Arun Kumar, UHID 6100000, IP07000123, Dr. Anand R). It contains no real patient data.

| File | What it is |
|---|---|
| `lab-report.template.html` | The full HTML of the Lab Report ("Diagnostics Summary"), with CSS and logos inlined. Open it in a browser; print it to PDF with Chromium (A4) |
| `lab-report.sample.pdf` | That HTML printed, as patients receive it |
| `lab-report.sample-rows.json` | The same values as rows for the `lab_results` collection (section 4.2): section, test, range, value, numeric, status, resultDate, resultDay |
| `discharge-summary.emr-input.example.html` | What the EMR's `pSummary.aspx` page looks like before restyling: the input of the summary step |
| `discharge-summary.template.html` | The page after the portal's restyle: the HTML that becomes the PDF |
| `discharge-summary.sample.pdf` | The Discharge Summary as patients receive it |
| `make-templates.mjs` | Regenerates all of the above from the portal's code (see below) |

### 26.1 Lab Report layout

Made by `buildInvestigationChartHtml` and printed by `renderHtmlToPdf` (Chromium, A4) in `investigationPdfService.js`; the letterhead and patient card come from `pdfBranding.js`.

1. **Letterhead:** hospital logo; name in English and Tamil (`HOSPITAL_NAME_EN`, `HOSPITAL_NAME_TA`); address line (`HOSPITAL_ADDRESS`); NABL and NABH badges with "NABL LAB · NABH ACCREDITED".
2. **Title band:** "DIAGNOSTICS SUMMARY", "Laboratory investigation chart · admission to discharge" (Ask AI lookups say "· <date range>"), and "Generated DD-MM-YYYY".
3. **Patient card:**
   - **Name.**
   - **Tags:** age · sex, unit, and blood group (the latest "BLOOD GROUP" value, if ordered).
   - **Fields:** UHID (highlighted), IP Number (`OP` for out-patients), Bed No., Report Period (first – last lab date), Assigned Ward, Unit / Specialty, Treating Physician.
4. **Legend:** Within normal (green), **H** Above range (orange), **L** Below range (red).
5. **Table:**
   - **Columns:** PARAMETER, REF. RANGE, then **at most 4 date columns per page**. More dates continue on further pages with the same header.
   - **Rows:** grouped by section (COMPLETE BLOOD COUNT, RENAL FUNCTION TEST …); tests without a section go under OTHER TESTS.
   - **Cells:** values coloured by the flag rule (section 9), with an H or L pill; empty cells show a dash.
6. **Disclaimer**, once at the end, in English and Tamil: "This is a digitally generated diagnostic summary for information only and is not a legal document … This WhatsApp copy is not valid for legal, insurance or other claims."

### 26.2 Discharge Summary layout

Made by `generateDischargeSummaryPdf` in `dischargeSummaryService.js`:
- **Input:** the EMR's own summary page, opened in Chromium with the session cookie.
- **Restyle:** the page gets `OVERRIDE_CSS` and is rewritten by one DOM script.
- **Optional review:** a Gemini pass (`geminiService.js`, needs `GEMINI_API_KEY`) only decides whether a section reads better as bullet points. It never changes the doctor's words.

1. **Letterhead** as above; title "DISCHARGE SUMMARY", "Clinical summary of the hospital stay".
2. **Patient card:**
   - **Name.**
   - **Tags:** age / sex, Ward, Bed.
   - **Fields:** UHID, IP Number, Admitted On, Discharged On.
   - **Source:** read from the EMR page: `.trpatname` (name), the next row (age / sex), and label cells "Register Number", "IP Number", "Admitted On", "Discharged On", "Ward Name", "Bed No", each followed by ":" and the value.
3. **Treating consultant banner** (`.txtdochdr` / `.Disdochdr`), with the ward.
4. **Final Diagnosis card:** the paragraph starting "FINAL DIAGNOSIS" / "DIAGNOSIS" plus the following lines until the next heading, one line per diagnosis.
5. **Section headings** (blue square bullet):
   - **Known headings:** CHIEF COMPLAINTS, HISTORY OF PRESENTING ILLNESS, PAST HISTORY, TREATMENT HISTORY, DURING ADMISSION, ANTHROPOMETRY, COURSE IN HOSPITAL, NUTRITIONAL ADVICE, TREATMENT GIVEN, STATUS DURING DISCHARGE, DISCHARGE ADVICE, REVIEW ADVICE.
   - **Any other heading:** an ALL-CAPS line of up to 50 characters ending with ":".
6. **Tables** (Word-exported `table.MsoNormalTable`):
   - **Medicines:** header row has S.NO and DRUG; dark header.
   - **Vitals strip:** HEART RATE and SATURATION.
   - **Anthropometry:** OBSERVED.
   - **Key–value:** two columns.
   - A heading and its table are kept together on one page.
7. **Discharge condition banner** (amber): for lines like DISCHARGED STABLE, AT REQUEST DISCHARGE, AGAINST MEDICAL ADVICE, LAMA, EXPIRED, TRANSFERRED.
8. **Review advice card** (green) for the lines under REVIEW ADVICE.
9. **Footer:**
   - "Prepared By / Verified By" strip (from "SUMMARY PREPARED BY:" / "SUMMARY VERIFIED BY:")
   - "Prepared & Approved by <consultant>"
   - **24/7 emergency helpline** banner in English and Tamil (044 2752 8528, toll-free 1800 599 0999)
   - **DISCLAIMER** in English and Tamil
   - audit line (EMR user and time)
10. **No patient data on the EMR page** (no name, UHID or dates found): the PDF is still stored but marked `summaryDataMissing`. That is the red **No Summary**, and it is never sent to the patient.

### 26.3 Regenerating the templates

Run inside the portal's backend container (it has Chromium and the code):
```bash
docker cp AI_FOR_AOSTRA/templates/make-templates.mjs investigation-backend:/app/make-templates.mjs
docker exec -w /app investigation-backend node make-templates.mjs     # writes /tmp/aostra/*
docker cp investigation-backend:/tmp/aostra/. AI_FOR_AOSTRA/templates/
docker exec investigation-backend rm -f /app/make-templates.mjs
```
The script uses the real `buildInvestigationChartHtml`, `letterheadHtml` and `BRAND_CSS`. For the summary, it reads `OVERRIDE_CSS` and the page-rewrite script straight from `dischargeSummaryService.js` and runs them on `discharge-summary.emr-input.example.html`, so the templates always match the live code.
