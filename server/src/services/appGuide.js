/**
 * The portal's own manual, for "Ask AI" (assistantService.js): what every
 * screen, button, badge and colour means, how OP lab reports and WhatsApp messages
 * flow, and what to do when something goes wrong. The assistant looks up the
 * few sections a question needs (searchGuide) instead of carrying all of it in
 * every prompt. Keep it in step with the UI when screens change.
 */

import { setting } from './appSettingsService.js';

// Timings the super admin can change in Master Settings — read when asked.
const S = (key) => setting(key);

export const GUIDE = [
  {
    id: 'overview',
    title: 'What the portal does',
    keywords: 'overview about purpose portal app application what is this op lab reports emr how it works flow',
    get text() {
      return `The OP Lab Reports Portal (Adhiparasakthi Hospitals) fetches Outpatient (OP) laboratory orders from the EMR, generates the OP Laboratory Report PDF once all active orders for that visit are approved, and can send it on WhatsApp:
1. Every ${S('opReports.checkMinutes')} minutes, on the clock, the server checks the EMR (emr.mapims.edu.in) for today's OP lab orders (and catches up on pending reports from the past 2 days)${S('opReports.autoCheck') ? '' : ' — automatic checks are paused right now in Master Settings'}.
2. Patients with partial orders (not all active tests yet RESULT APPROVED) appear as Pending (e.g. 2/3 orders approved). Once every active order is RESULT APPROVED, the portal builds the OP Laboratory Report PDF.
3. PDFs are stored in MinIO and the patient index in MongoDB.
4. In Live mode each ready OP Lab Report PDF goes to the patient's WhatsApp through WATI automatically; in Test mode nothing is sent automatically and manual sends go to the test number.
Screens: Lab Search, OP Reports, Lab Finder, WATI Settings, Monitor (WhatsApp Monitor), Audit Log and, for the super admin, Users and Settings (Master Settings). Each person sees only the screens and features their account allows (see "Users and access").`;
    },
  },
  {
    id: 'login',
    title: 'Login screen',
    keywords: 'login sign in password username lock screen logout session expired log out forgot reset',
    get text() {
      const idle = S('auth.idleSignOutMinutes');
      return `The portal opens on a full-screen lock screen: clock, hospital name, and the Staff sign in card (username + password, eye icon shows the password). A session lasts ${S('auth.sessionHours')} hours; after that, or after Logout (top right), you sign in again. "Please log in again" means the session expired.${idle ? ` With no mouse or keyboard activity for ${idle} minutes you're signed out (a one-minute warning shows first).` : ''}`;
    },
  },
  {
    id: 'navigation',
    title: 'Header, tabs and the profile menu',
    keywords: 'header tabs navigation menu top bar missing tab hidden lab finder monitor ask ai profile avatar name logout sign out where',
    text: `Top bar: hospital name on the left; the tabs this account may open (Lab Search, OP Reports, Lab Finder, WATI Settings, Monitor, Audit Log, and Users and Settings for the super admin); on the right the profile button (initials + name). A tab or the Ask AI button that's missing means the account doesn't include it — the super admin can add it, or it is switched off for everyone in Master Settings. A coloured bar at the top of the page is an announcement from the super admin; a grey dashed "Read-only mode" bar means the portal is under maintenance (view only). The profile button shows your access, your access hours, Change password and Sign out. /admin opens the WhatsApp Monitor and /users the user list directly.`,
  },
  {
    id: 'op-reports',
    title: 'OP Reports screen',
    keywords: 'op reports screen date previous next today yesterday check now countdown sync stats chips found ready pending generated failed filter search cards table view category all patients lab ready corporate advanced search',
    text: `Shows every outpatient (OP) with lab orders on the chosen visit date, their approval progress, and their OP Lab Report PDF.
- Date bar: Prev / Next day (keys [ and ], or arrow keys), Today (key T), or pick a date. "Check Now" runs the EMR check immediately; otherwise checks run on schedule (countdown shown).
- Stat chips after a check: found (OP patients with active lab orders), ready (PDF ready), generated (new PDFs made), pending (waiting for remaining active orders to become RESULT APPROVED), no lab data, failed.
- Category chips: All Patients, 📋 Lab Ready, ⏳ Pending Approval, ⏳ No Lab Data, 🏢 Corporate.
- Filter box: type anything — name (any part, any order), UHID, mobile number in any format (+91 98765 43210, or its last digits), token number, visit type, lab Req No, doctor, department, town (Escape clears). If nobody on that date matches, "Search all dates" looks across every date.
- Cards / Table switch (top right of the list). Advanced Search searches across all stored OP dates using any combination of UHID, name, doctor, department, visit type, token number, patient type, mobile, created by and date range.`,
  },
  {
    id: 'patient-card',
    title: 'Patient card — every part',
    keywords: 'card patient card stripe colour color teal green blue top line avatar initials badge general corporate lab dates uhid copy department doctor mobile token visit type created by pending orders',
    text: `Each card, top to bottom:
- Thin line along the top: teal = General patient, blue = Corporate patient (matching the patient-type badge).
- Round avatar with the patient's initials, the name, patient-type badge, and "N lab dates" (days with lab results) or "Pending · A/B ready" when active tests are still awaiting approval.
- UHID box — click the copy icon to copy — along with Token No & Visit Type when available.
- Ordering Department and Consulting Doctor.
- Mobile (+91…, tap to call; a red "Not on WhatsApp" badge means the last WhatsApp to it failed because the number isn't on WhatsApp), Created by (front-office user), and Report Date (Today / Yesterday / date).
- Buttons: Lab Report (or Pending badge while awaiting approval), and the round WhatsApp button (see "Card buttons").`,
  },
  {
    id: 'card-buttons',
    title: 'Card buttons: Lab Report, Pending, No lab data, WhatsApp',
    keywords: 'button buttons lab report pending orders no lab data grey amber whatsapp green round icon tooltip failed click to retry sent tick disabled',
    text: `- Lab Report (blue): opens the OP Laboratory Report PDF. Only active once all non-cancelled lab orders for that visit date have STATUS = RESULT APPROVED.
- Pending · A/B ready (amber): at least one active order is not yet RESULT APPROVED (e.g. Sample Collected or Result Entered); once all are approved, the next check builds the PDF automatically.
- "No lab data" (grey, dashed): no usable numeric/structured lab result rows were returned for those orders.
- WhatsApp (round green button): sends the OP Lab Report PDF. In Test mode it goes to the test number, in Live mode to the patient. With "Confirm the number first" on (WATI Settings, on by default) a popup shows that number first — check or change it (it warns if e.g. only 9 digits), then Send. Hover to see what it will do; after a failure the hover text says why ("Failed: … — click to retry"). A filled green icon means sent.`,
  },
  {
    id: 'lab-report-pdf',
    title: 'OP Laboratory Report PDF',
    keywords: 'lab report pdf op laboratory investigation contents layout h l high low flag reference range disclaimer tamil header patient details',
    text: `The OP Laboratory Report PDF has the hospital header, an OP patient summary row (name, UHID, Category/Visit Type, Token No, Ordering Department, Consulting Doctor, age/sex, report period), then every lab result grouped by test and date with reference ranges. Results above range are marked H (orange), below range L (red). It ends with a DISCLAIMER in English and Tamil. IT can rebuild existing PDFs with the regenerateReports.js script.`,
  },
  {
    id: 'lab-search',
    title: 'Lab Search screen',
    keywords: 'lab search screen uhid op date range chart trend recent searches print',
    text: `Lab Search looks up one OP patient's lab results straight from the EMR: enter the UHID (registration number), choose the date range, and search. Results show as tables with a trend chart ("Automated Trend Analysis") and can be printed. Recent searches are listed for one click.`,
  },
  {
    id: 'lab-finder',
    title: 'Lab Finder screen',
    keywords: 'lab finder search across patients test result contains flag high low value from to dates department patient uhid export pdf excel word csv whatsapp share examples coverage',
    text: `Lab Finder searches stored lab values across all ready OP patients: Test (suggestions as you type), Result contains (e.g. Negative), Flag (High, Low, High or low, Within range), Value from/to, From/To dates, "Dates are" report or test result dates, Patient or UHID, Department. "Try:" chips run example searches. Results can be downloaded as PDF, Excel, Word or CSV, or sent on WhatsApp to a number you type. Coverage (which report dates have stored values) is shown in the header.`,
  },
  {
    id: 'wati-settings',
    title: 'WATI Settings screen (Test mode / Live)',
    keywords: 'wati settings test mode live mode delivery mode test number extra message line preview template switch real patients go live turn on off',
    text: `WATI Settings controls WhatsApp delivery:
- Delivery mode: Test mode (default) — nothing is sent automatically; the WhatsApp button sends to the Test number. Live — ready OP Lab Report PDFs go automatically to each patient's own mobile as they're completed, and the button sends to the patient. Turning Live on asks "Send reports to real patients?".
- Test number: receives every manual send in Test mode.
- Extra message line: optional text included as parameter {{2}} in the WATI message. In Live mode every patient reads it — a red warning shows then; clear test notes.
- Message preview: shows the WhatsApp message as the patient sees it, and the active OP template name.
- Before sending → Confirm the number first: the patient-card WhatsApp button shows the number in a popup to check or edit before sending.
- Template: configured in WATI Settings for OP Lab Reports and Ask AI lab lookups.`,
  },
  {
    id: 'whatsapp-template',
    title: 'The WhatsApp template',
    keywords: 'template investigation mapims_lab_rpt message text footer lab report header document dear variables',
    text: `WhatsApp messages send the PDF header media together with the approved OP WATI template selected in WATI Settings (for example mapims_lab_rpt / investigation_report / investigation), filling patient name and optional document note parameters.`,
  },
  {
    id: 'whatsapp-statuses',
    title: 'WhatsApp statuses and ticks',
    keywords: 'status statuses tick ticks single double grey blue pending sent delivered read failed not on whatsapp meaning',
    text: `- Pending: the app is handing it to WATI.
- Sent (one grey tick ✓): WATI accepted it.
- Delivered (two grey ticks ✓✓): it reached the patient's phone.
- Read (two blue ticks): the patient opened it.
- Failed (red): WATI or WhatsApp refused it — the reason is on the message.
- Not on WhatsApp: that mobile number has no WhatsApp; check the number in the EMR.
"One tick for 6 h+" usually means the phone is off or offline; "Delivered, unread for 24 h+" may need a call.`,
  },
  {
    id: 'auto-send',
    title: 'When WhatsApp messages are sent',
    keywords: 'automatic auto send when trigger manual click share retry live test flow order',
    text: `- Automatic (Live mode only, and "Send automatically in Live mode" on in Master Settings): as soon as an OP patient's active lab orders are all RESULT APPROVED and their PDF is built during the regular EMR check, it's sent once to the patient.
- Manual click: the round WhatsApp button on a card (Test mode → test number; Live → patient).
- Share: from Lab Finder / Ask AI, to a number you type.
- Retry: automatic re-sends, or the Retry button in the Monitor.
Every send is logged in the WhatsApp Monitor with who triggered it.`,
  },
  {
    id: 'retries',
    title: 'Automatic retries',
    keywords: 'retry retries retrying again automatic when will it retry failed resend button how often not on whatsapp wrong tag 6 hours 3 days',
    get text() {
      const h = S('retry.everyHours');
      const d = S('retry.forDays');
      const q = S('retry.quickMinutes');
      const perDay = Math.round((24 / h) * 10) / 10;
      if (!S('retry.enabled')) {
        return `Automatic retries are switched off in Master Settings — failed reports wait for someone to press Retry: Monitor → open the message → Retry now. The super admin can switch them back on (Settings → Automatic retries).`;
      }
      return `Failed OP lab reports are re-sent automatically, light on WATI's quota (the super admin sets all of this in Settings → Automatic retries):
- Failed to send (network, WATI busy): ${q ? `one quick retry after ${q} minutes, then ` : ''}every ${h} hours for ${d} days (${perDay} a day, about ${Math.ceil((d * 24) / h)} tries).
- Not on WhatsApp: ${S('retry.notOnWhatsApp') ? `also retried — every ${h} hours for ${d} days — because the tag is sometimes wrong: the phone may be off or its data off for days, or WhatsApp not updated. If it goes through, it shows as sent / delivered / read.` : 'not retried automatically (switched off in Master Settings); use Retry in the Monitor.'}
- WATI usage limit (429): every hour, and once WATI's pause ends.
- Template or setup errors aren't retried — they need a person.
At most one try per phone number per round, and at most ${S('retry.dailyCap')} automatic tries a day. Any failed report can be re-sent by hand any time: Monitor → open the message → Retry now. The Monitor shows "Failed to send" and "Not on WhatsApp" separately.`;
    },
  },
  {
    id: 'wati-quota',
    title: 'WATI usage limit / 429 / WhatsApp not sending',
    keywords: 'wati 429 usage limit exceeded quota api calls not sending whatsapp not working why failed monthly limit reset plan emr blocked test mode live mode not trigger',
    text: `"WATI API usage limit exceeded (429)" means WATI is refusing every API call from the hospital's WATI account — sends included, in Test and Live mode alike (it's the account, not the mode). Every WATI API call counts toward a monthly quota, and other hospital flows may share the account.
What the app does: stops status checks, pauses automatic retries (1 h, then 3 h, 6 h), and re-sends every refused report automatically once WATI accepts again. Staff don't need to click again.
To send sooner: ask WATI support to reset or raise the limit. To prevent it: connect the WATI webhook (Monitor → WATI connection) so status checks aren't needed; status checks are capped per day.`,
  },
  {
    id: 'plugin-not-supported',
    title: '"This plugin is not supported" in WATI inbox',
    keywords: 'plugin not supported wati inbox pdf preview not showing document blank http https link expired',
    text: `In WATI's Team Inbox the PDF shows "This plugin is not supported" when its link is plain http (WATI's page is https, so the browser blocks it) or has expired. The patient still gets the PDF — WhatsApp downloads it when the message is sent. Fix: serve the app over https and set PUBLIC_BASE_URL; new links are then https and stay valid 2 days. The Monitor's WATI connection card shows whether links are https.`,
  },
  {
    id: 'pdf-links',
    title: 'PDF links sent on WhatsApp',
    keywords: 'pdf link expire expiry valid days 2 days how long link open later minio public link',
    text: `The PDF link inside a WhatsApp message is valid for 2 days (WHATSAPP_LINK_DAYS, up to 7). WhatsApp saves the file on the phone when the message arrives, so patients can open it later anyway; the link matters for WATI's inbox. Links are signed, so they can't be changed to open another patient's report. Opening an expired link says "This link has expired".`,
  },
  {
    id: 'monitor',
    title: 'WhatsApp Monitor screen (/admin)',
    keywords: 'monitor admin whatsapp monitor dashboard analytics live check wati now presets today yesterday filters tiles charts kpi dates by report date sent date op count wrong',
    text: `The WhatsApp Monitor (the Monitor tab, or /admin) tracks every message:
- Header: "Live · updated …" (refreshes every 15 s), when WATI was last checked or that it's paused, and "Check WATI now" (asks WATI for the latest ticks; max once per 5 min).
- Filters in one row: date presets (Today, Yesterday — the default, Last 7 days, Last 30 days, This month, Custom), "Dates by", status chips, document, trigger (automatic / manual click / share / retry) and search by name, UHID or number.
- Time: optional from–to time of day (India time). With Report date it filters OP report creation/order time; with Sent date it filters when the message went out. × clears it.
- "Dates by": Report date (default) counts OP patients by visit/report date — so Today = today's OP lab patients only. Sent date counts by when the message went out, so Today also includes earlier patients' reports sent or re-sent today.
- Tiles: Triggered, Sent, Delivered, Read, Pending, Failed — each with a trend and the change vs the previous period.
- WATI connection card, Coverage (OP patients: sent / not sent / no mobile / not ready yet), Needs attention (failed — can be fixed, not on WhatsApp, unread 24 h+, one tick 6 h+).
- Charts: Messages over time, Delivery & read rate, When patients open reports, How long until read, Status by trigger, Why messages fail, By department, Who clicked.
- Live activity feed and the Patients / Messages table (click a row for its timeline and Retry now). Export to Excel, PDF, CSV or JSON.`,
  },
  {
    id: 'wati-connection-card',
    title: 'Monitor → WATI connection card',
    keywords: 'wati connection card api calls today month status checks webhook connected pdf links green amber red',
    text: `Three tiles: "API calls from this app" (today's sends and status checks out of the daily allowance, this month's total, and a red warning while WATI refuses calls with the time it resumes), "Delivered / read updates" (green when the WATI webhook is connected; otherwise status checks are used — "Connect the webhook" shows the steps and the URL to copy), and "PDF links" (green when links are https; amber for plain http). Counts cover this app only.`,
  },
  {
    id: 'webhook',
    title: 'Connecting the WATI webhook',
    keywords: 'webhook connect setup wati connectors url instant ticks delivered read events',
    text: `A webhook makes WATI tell the portal instantly when a message is sent, delivered, read or failed — free, no API quota used, and status checks stop by themselves. Steps: Monitor → WATI connection → "Connect the webhook" → copy the URL; in WATI open Connectors → Webhooks → Add Webhook, paste it, set Enabled, tick Template Message Sent, Delivered, Read, Replied and Failed, Save. Keep the URL private.`,
  },
  {
    id: 'not-on-whatsapp',
    title: 'Not on WhatsApp',
    keywords: 'not on whatsapp invalid number wrong mobile number red badge 131026 undeliverable',
    text: `"Not on WhatsApp" means WATI/WhatsApp said the patient's mobile has no WhatsApp account (or it's mistyped). Check and correct the mobile number in the EMR; the card shows a red "Not on WhatsApp" badge next to the mobile, and the Monitor lists them under Needs attention.`,
  },
  {
    id: 'no-lab-data',
    title: 'Pending vs No lab data / failed',
    keywords: 'pending awaiting approval no lab data missing lab report why not generated empty failed generate',
    text: `"Pending" (amber, e.g. 2/3 orders approved) means some active lab orders for that visit date are not yet RESULT APPROVED in the EMR; the portal automatically re-checks and builds the PDF as soon as all active orders are approved. "No lab data" means no structured test rows came back for those orders. "failed" means PDF rendering errored and will retry on the next check.`,
  },
  {
    id: 'ask-ai',
    title: 'Ask AI (this assistant)',
    keywords: 'ask ai assistant chat help what can you do privacy data sent',
    text: `Ask AI (bottom right, for accounts with Ask AI turned on) can: find an OP patient's reports (UHID, mobile, token or name) with download and WhatsApp options; list OP lab patients for a date; search lab results across patients (e.g. "urine glucose negative last week") and export them; look up any UHID's multi-day lab chart straight from the EMR; take you to a screen; explain any screen, button or colour; and report live status — WATI quota and pauses, webhook, Test/Live mode, the OP check schedule, WhatsApp sent/delivered/read/failed counts and why a message failed. Patient names and lab values stay in the portal; the AI service only sees counts and IDs unless allowed in Master Settings.`,
  },
  {
    id: 'users-access',
    title: 'Users and access (super admin)',
    keywords: 'user users account accounts add create staff role roles permission permissions access rbac super admin screen read only write edit disable delete reset password hours schedule preset doctor nurse front desk lab viewer',
    text: `The super admin (the login in the server .env) manages everyone on the Users screen:
- Add user: profile (name, username, designation, department, mobile, email, password — Generate makes one), then a role preset (Admin, Doctor, Nurse / clinic staff, Lab staff, Front desk, View only) and adjust.
- Screens: tick each screen the person may open, then View only, or View & send (View & edit on WATI Settings). View & send on OP Reports = Check Now and sending WhatsApp; on Lab Finder = sharing on WhatsApp; on the Monitor = Retry and "Check WATI now". View & edit on WATI Settings = changing mode, number and extra line. Lab Search is look-up only.
- Ask AI: Off, Ask questions, or Ask + send (share / test messages). It only ever shows what the person's screens allow.
- WhatsApp button on patient cards: on or off (needs OP Reports View & send).
- Access hours: days and a from–to time (India time; overnight works). Outside them they can't sign in and an open session ends.
- On the list: the switch disables an account; the key sets a new password; the arrow signs them out on every device; the bin deletes. Too many wrong passwords lock an account for a while (Master Settings → Sign-in & security; the lock icon unlocks it).
Changes apply from the person's next click. Every rule is checked by the server too, not just hidden.`,
  },
  {
    id: 'audit-log',
    title: 'Audit Log',
    keywords: 'audit log activity who did what when track tracking sign in sign out login logout session idle inactive tab away time clicks cancelled popup ai chats history department user report',
    text: `The Audit Log (tab "Audit Log"; super admin, or anyone given access) records who did what and when: sign-ins (and failed ones), sign-outs and session length, every screen opened, OP report dates viewed, filters used, UHIDs copied, PDFs opened, each WhatsApp click — and whether the popup was sent (to which number, edited or not) or cancelled — retries, exports, settings and user changes, and every Ask AI question with its answer. Each session shows active time, idle time (no mouse or keyboard for 5+ minutes) and time away from the tab.
Views: Timeline (click a row for details, a person to see only them, "Show this session"), People, Departments, Sessions (online now, signed out or closed without signing out) and AI chats (full conversations). Filter by dates, person, department, type and text; "Show tab switches & idle" adds those events. Download as Excel or CSV. Opening or downloading the audit log is itself logged; so is every Master Settings change.`,
  },
  {
    id: 'my-profile',
    title: 'My profile and password',
    keywords: 'my profile password change forgot locked sign out account hours my access',
    text: `Click your name at the top right: it shows your access and access hours. Change password asks for the current one and signs you out on other devices. Passwords are stored encrypted — nobody, not even the super admin, can see them. Forgot it, or locked after five wrong tries? Ask the super admin to reset it: they set a temporary password, and when you sign in with it you choose your own before anything else, so only you know it. The super admin's own password is set in the server .env (APP_PASSWORD).`,
  },
  {
    id: 'op-lookup',
    title: 'Direct EMR lab lookup by UHID (Ask AI)',
    keywords: 'op out patient outpatient uhid lab report emr fetch find search multi day range whatsapp send number pdf download',
    text: `To generate an OP lab chart across an arbitrary date range straight from the EMR lab (by default the last ${S('ai.lookupDays')} days — Master Settings → Ask AI; say "last 6 months" or specific dates for more), ask Ask AI e.g. "find UHID 6214201" or "lab report of UHID 6214201 last 3 months". Then Open, Download, or WhatsApp: give the number, press Send, and the card shows delivery status. Needs Lab Search access; sending needs Ask AI "Ask + send".`,
  },
  {
    id: 'test-message',
    title: 'Sending a test WhatsApp message',
    keywords: 'test message send test whatsapp check working try number text',
    text: `To check WhatsApp is working, ask Ask AI: "send a test message" (it asks for the text, then the number) or all at once: send "TEST MESSAGE" to +91 99624 60782. It shows a card with the message and number — press Send (or type yes). It goes through the approved report template: your text appears in the message with a small "WhatsApp Test Message" PDF, because WhatsApp only allows free text within 24 hours of the person messaging the hospital. Each test uses one WATI API call and is listed in the WhatsApp Monitor as "Test message".`,
  },
  {
    id: 'ai-reports',
    title: 'Reports from Ask AI',
    keywords: 'report reports generate make create table download excel pdf csv json patient wise message wise time between hours am pm op list count department doctor pending',
    text: `Ask AI builds reports on request, with any dates and times, shown as a table with downloads:
- WhatsApp report (needs WhatsApp Monitor access): e.g. "today 10 am to 2 pm WhatsApp report patient and message wise", "failed messages yesterday", "WhatsApp sent between 6 pm and 9 pm". Patient-wise and Message-wise tabs; download Excel, PDF, CSV or JSON; "Open in WhatsApp Monitor" opens the Monitor with the same filters.
- OP Lab report (needs OP Reports access): e.g. "OP patients today", "ENT OP visits this week still pending", "Dr. Samson's OP patients yesterday not sent on WhatsApp". Totals, departments, approval progress, lab PDF & WhatsApp status; download Excel, PDF or CSV.
Times are India time; "8 pm to 8 am" means overnight from the evening before.`,
  },
  {
    id: 'ai-patient-answers',
    title: 'Ask AI: patient details, journey, compare, files',
    keywords: 'find search patient by phone mobile number who has belongs details whatsapp number mobile age address visit time token format journey flowchart timeline compare comparison two patients two reports change pdf csv excel group results combine file number #1 #2',
    text: `Ask AI answers with the patient's own data. Find an OP patient by anything — "find the patient with phone 98765 43210", "who is from Tindivanam", "arun kumar", a UHID, token number or lab Req No; it searches every report date, best match first, and says what matched:
- Details: "WhatsApp number and visit date of UHID 6214201", "age and address of UHID 6214201" — mobile, age, gender, address, city, visit type, token no, doctor, department, lab order approval status, WhatsApp status, out-of-range lab values.
- Journey: "patient journey of UHID 6214201" — a timeline from OP registration, lab request/result days, report generation, WhatsApp sent / delivered / read and staff actions.
- Compare: "compare UHID… and UHID…" (two patients side by side) or "compare the lab reports of UHID… first vs last day" — every test with both values and the change.
- Files: every table or card in a chat is numbered #1, #2 …; ask "put #1 and #2 in one PDF and #3 in a CSV", "everything in one PDF", "first two in Excel" (add "with answers" to include the questions and replies).
Patient details are sent to the AI service to answer (Master Settings → Ask AI → "Let the AI service read patient details"; ABHA ID and religion never are).`,
  },
  {
    id: 'exports',
    title: 'Downloads and exports',
    keywords: 'download export excel xlsx pdf word docx csv json file format',
    text: `Lab Finder and Ask AI results download as PDF, Excel (.xlsx), Word (.docx) or CSV; a single patient's PDF opens from the Lab Report button once ready. The WhatsApp Monitor exports messages or patients as Excel, PDF, CSV or JSON for the selected dates and filters. If the download buttons are missing, downloads are switched off for everyone in Master Settings (or read-only mode is on).`,
  },
  {
    id: 'master-settings',
    title: 'Master Settings (super admin)',
    keywords: 'master settings setting configure configuration control options switch toggle global everyone hide whatsapp button icon disable feature retry hours days interval timing announcement banner notice maintenance read only lock idle sign out session password length audit retention refresh',
    text: `Settings tab (gear icon, /settings) — super admin only. Every switch and timing of the portal in one place; changes apply to everyone as soon as you save, and open screens update within a minute.
- At a glance: WhatsApp mode, retries, the OP lab automation check and the portal state; click one to jump to its section.
- Features for everyone: switch off for all staff at once, above their own access — WhatsApp button on patient cards, Ask AI, Ask AI sending, Ask AI EMR lookup, Lab Search, Lab Finder, downloads & exports. Each shows how many staff have it. The super admin always keeps everything.
- WhatsApp sending: send automatically in Live mode (off = Live mode only for the WhatsApp button), how many days the PDF link works. Live / Test mode, test number and templates stay on WATI Settings.
- Automatic retries: on/off, also retry "Not on WhatsApp", retry every N hours, for N days, quick first retry, daily cap — with a timeline showing every try.
- WATI API usage: status checks for ticks on/off and per day, with today's usage meters.
- OP Lab Automation: check the EMR automatically (pause), how often (5–60 min), and how often OP Reports refreshes.
- Sign-in & security: session length, sign out after no activity, wrong-password lockout and minutes, shortest password.
- Ask AI: let the AI read patient details, how far back the EMR lookup searches.
- Audit log: keep records for N days, record tab switches and idle time.
- Announcement & maintenance: a message at the top of every screen (blue / amber / red, preview shown) and read-only mode (staff can view only; no sending, retries, downloads or changes; automatic sending pauses).`,
  },
  {
    id: 'it-admin',
    title: 'For IT: deploy, scripts and settings',
    keywords: 'it admin deploy vps docker compose update pull build script regenerate backfill env settings https nginx certbot server restart',
    text: `Docker Compose project: op-lab-reports (ports: client 1021, server 2021, mongo 3021, minio 4021/5021).
Scripts (inside the backend container, docker exec op-lab-backend node src/scripts/…): regenerateReports.js (rebuild recent OP Lab Report PDFs), backfillLabResults.js --all (store lab values for Lab Finder).
Root .env settings: PUBLIC_BASE_URL (https address for PDF links), WHATSAPP_LINK_DAYS (default 2), WATI_STATUS_CHECKS_PER_DAY (default 100), MINIO_PUBLIC_ENDPOINT, GROQ_API.`,
  },
];

const STOP = new Set(
  'a an the is are was were be to of in on at for and or it this that what why how when where who does do did can i my me we you your please show tell about mean means meaning there here with from not no'.split(' '),
);

const words = (text) =>
  String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9?=]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** The sections that best match a question, best first (score ≥ minScore). */
export function searchGuide(question, limit = 3, minScore = 1) {
  const q = words(question);
  if (!q.length) return [];
  const scored = GUIDE.map((section) => {
    const title = words(section.title);
    const keys = words(section.keywords);
    const body = words(section.text);
    let score = 0;
    for (const w of q) {
      const stem = w.replace(/(ing|ed|es|s)$/, '');
      const hit = (list) => list.some((x) => x === w || (stem.length > 3 && x.startsWith(stem)));
      if (hit(title)) score += 3;
      if (hit(keys)) score += 2;
      if (hit(body)) score += 1;
    }
    return { section, score };
  });
  return scored
    .filter((s) => s.score >= Math.max(1, minScore))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.section);
}

export const GUIDE_TOPICS = GUIDE.map((s) => s.title);
