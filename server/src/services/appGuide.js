/**
 * The portal's own manual, for "Ask AI" (assistantService.js): what every
 * screen, button, badge and colour means, how reports and WhatsApp messages
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
    keywords: 'overview about purpose portal app application what is this diagnostics summary emr how it works flow',
    get text() {
      return `The Diagnostics Summary Portal (Adhiparasakthi Hospitals) turns EMR data into two PDFs for every discharged patient and can send them on WhatsApp:
1. Every ${S('discharge.checkMinutes')} minutes, on the clock, the server checks the EMR (emr.mapims.edu.in) for today's discharges${S('discharge.autoCheck') ? '' : ' — automatic checks are paused right now in Master Settings'}.
2. For each new patient it builds the Lab Report (all lab results of the stay, as a "Diagnostics Summary" PDF) and fetches the Discharge Summary.
3. PDFs are stored in MinIO, the patient list in MongoDB.
4. In Live mode both PDFs go to the patient's WhatsApp through WATI automatically; in Test mode nothing is sent automatically and manual sends go to the test number.
Screens: Lab Search, Discharge Reports, Lab Finder, WATI Settings, Monitor (WhatsApp Monitor), Audit Log and, for the super admin, Users and Settings (Master Settings). Each person sees only the screens and features their account allows (see "Users and access").`;
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
    text: `Top bar: hospital name on the left; the tabs this account may open (Lab Search, Discharge Reports, Lab Finder, WATI Settings, Monitor, Audit Log, and Users and Settings for the super admin); on the right the profile button (initials + name). A tab or the Ask AI button that's missing means the account doesn't include it — the super admin can add it, or it is switched off for everyone in Master Settings. A coloured bar at the top of the page is an announcement from the super admin; a grey dashed "Read-only mode" bar means the portal is under maintenance (view only). The profile button shows your access, your access hours, Change password and Sign out. /admin opens the WhatsApp Monitor and /users the user list directly.`,
  },
  {
    id: 'discharge-reports',
    title: 'Discharge Reports screen',
    keywords: 'discharge reports screen date previous next today yesterday check now countdown sync stats chips found ready generated failed filter search cards table view category all patients lab ready summary ready no lab data corporate advanced search',
    text: `Shows every patient discharged on the chosen date with their two PDFs.
- Date bar: Prev / Next day (keys [ and ], or arrow keys), Today (key T), or pick a date. "Check Now" runs the EMR check immediately; otherwise it runs every 15 minutes (countdown shown).
- Stat chips after a check: found (discharges seen), generated (new lab reports), ready (already made), no lab data, failed, summaries, summary issues (will retry next check).
- Category chips: All Patients, 📋 Lab Ready, 📄 Summary Ready, ⏳ No Lab Data, 🏢 Corporate.
- Filter box: type anything — name (any part, any order), IP number, UHID, mobile number in any format (+91 89396 05869, or its last digits), lab Req No, doctor, ward, town (Escape clears). If nobody on that date matches, "Search all dates" looks across every date.
- Cards / Table switch (top right of the list). Advanced Search has a "Search anything" box (every date, best match first) plus fields for IP number, UHID, name, doctor, department, ward, patient type, mobile, created by and discharge date period.`,
  },
  {
    id: 'patient-card',
    title: 'Patient card — every part',
    keywords: 'card patient card stripe colour color teal green blue top line avatar initials badge general corporate lab dates ip no uhid copy department ward doctor mobile created by discharged approved by summary unavailable pending',
    text: `Each card, top to bottom:
- Thin line along the top: teal = General patient, blue = Corporate patient (the same as the General / Corporate badge).
- Round avatar with the patient's initials, the name, the patient-type badge, and "N lab dates" (days with lab results) or "No lab data".
- IP NO and UHID boxes — click the copy icon to copy.
- Department and ward.
- Doctor (treating consultant), Mobile (+91…, tap to call; a red "Not on WhatsApp" badge means the last WhatsApp to it failed because the number isn't on WhatsApp), Created by (who made the EMR discharge entry), Discharged (Today / Yesterday / date).
- "Approved by …" (a green tick) when the discharge summary is approved; "Discharge summary unavailable" or "Discharge summary pending" otherwise.
- Buttons: Lab Report, Summary, and the round WhatsApp button (see "Card buttons").`,
  },
  {
    id: 'card-buttons',
    title: 'Card buttons: Lab Report, Summary, No lab data, No Summary, WhatsApp',
    keywords: 'button buttons lab report summary no lab data grey no summary red whatsapp green round icon tooltip failed click to retry sent tick disabled',
    text: `- Lab Report (blue): opens the lab report PDF.
- "No lab data" (grey, dashed): the EMR has no lab orders for this stay — not an error; it's checked once and not re-checked.
- Summary (green): opens the discharge summary PDF.
- "No Summary" (red): the EMR returned a discharge summary with no patient data, so it isn't shown or sent. Fix it in the EMR; the next check picks it up.
- WhatsApp (round green button): sends the lab report and the discharge summary as two messages. In Test mode they go to the test number, in Live mode to the patient. With "Confirm the number first" on (WATI Settings, on by default) a popup shows that number first — check or change it (it warns if it's e.g. only 9 digits), then Send. Hover to see what it will do; after a failure the hover text says why ("Failed: … — click to retry"). A filled green icon means sent.`,
  },
  {
    id: 'lab-report-pdf',
    title: 'Lab Report PDF (Diagnostics Summary)',
    keywords: 'lab report pdf diagnostics summary contents layout h l high low flag reference range disclaimer tamil header patient details',
    text: `The Lab Report PDF ("Diagnostics Summary") has the hospital header, a patient row (name, IP No, UHID, age/sex, department, doctor, dates), then every lab result of the stay grouped by test and date, with reference ranges. Results above range are marked H (orange), below range L (red). It ends with a DISCLAIMER in English and Tamil. IT can rebuild existing PDFs with the regenerateReports.js script.`,
  },
  {
    id: 'summary-pdf',
    title: 'Discharge Summary PDF',
    keywords: 'discharge summary pdf document approved diagnosis diagnostics contents disclaimer red underline no data',
    text: `The Discharge Summary is the EMR's own discharge summary, fetched and restyled with the hospital branding (headings use "DIAGNOSTICS"), with an English + Tamil disclaimer. If the EMR returns it without patient data it's marked "No Summary" and never sent. An existing good summary is kept if a later fetch comes back empty.`,
  },
  {
    id: 'lab-search',
    title: 'Lab Search screen',
    keywords: 'lab search screen uhid ip number inpatient op date range chart trend recent searches print',
    text: `Lab Search looks up one patient's lab results straight from the EMR: enter the OP UHID or the Inpatient Number (IP…), choose the date range, and search. Results show as tables with a trend chart ("Automated Trend Analysis") and can be printed. Recent searches are listed for one click. For discharged patients' ready-made PDFs use Discharge Reports instead.`,
  },
  {
    id: 'lab-finder',
    title: 'Lab Finder screen',
    keywords: 'lab finder search across patients test result contains flag high low value from to dates department patient export pdf excel word csv whatsapp share examples coverage',
    text: `Lab Finder searches stored lab values across all discharged patients: Test (suggestions as you type), Result contains (e.g. Negative), Flag (High, Low, High or low, Within range), Value from/to, From/To dates, "Dates are" discharge or test result dates, Patient or IP No, Department. "Try:" chips run example searches. Results can be downloaded as PDF, Excel, Word or CSV, or sent on WhatsApp to a number you type. Coverage (which discharge dates have stored values) is shown in the header.`,
  },
  {
    id: 'wati-settings',
    title: 'WATI Settings screen (Test mode / Live)',
    keywords: 'wati settings test mode live mode delivery mode test number extra message line preview template switch real patients go live turn on off',
    text: `WATI Settings controls WhatsApp delivery:
- Delivery mode: Test mode (default) — nothing is sent automatically; the WhatsApp button sends to the Test number. Live — both PDFs go automatically to each patient's own mobile as they're made, and the button sends to the patient. Turning Live on asks "Send reports to real patients?".
- Test number: receives every manual send in Test mode.
- Extra message line: optional text after "Attached: Lab Report" / "Attached: Discharge Summary". In Live mode every patient reads it — a red warning shows then; clear test notes.
- Message preview: shows the WhatsApp message as the patient sees it, and the template name.
- Before sending → Confirm the number first: the patient-card WhatsApp button shows the number in a popup to check or edit before sending.
- Template for Ask AI lab reports: mapims_lab_rpt ("Your laboratory report is ready"), investigation_report, or investigation — used when Ask AI sends a lab report it found in the EMR.
Each document is its own message (WhatsApp allows one file per template message). A summary with no patient data is never sent.`,
  },
  {
    id: 'whatsapp-template',
    title: 'The WhatsApp template',
    keywords: 'template investigation message text footer lab report header document dear variables mapims_discharge_summary approve',
    text: `Messages use the approved WATI template "investigation": "Dear {{1}}, Your investigation report is ready. Please find the report attached. {{2}} For any assistance, please contact Adhiparasakthi Hospital. Thank you." {{1}} is the patient's name, {{2}} is "Attached: Lab Report" or "Attached: Discharge Summary" plus the extra line, and the PDF is the message header. The footer "Lab report" is fixed in the template, so it also shows on summaries — change it in WATI (needs Meta re-approval) or get a separate summary template approved.`,
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
    keywords: 'automatic auto send when trigger manual click share retry live test flow two messages order',
    text: `- Automatic (Live mode only, and "Send automatically in Live mode" on in Master Settings): as soon as each PDF is made in the regular EMR check, it's sent to the patient — lab report first, then the discharge summary.
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
      return `Failed lab reports and summaries are re-sent automatically, light on WATI's quota (the super admin sets all of this in Settings → Automatic retries):
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
    text: `"WATI API usage limit exceeded (429)" means WATI is refusing every API call from the hospital's WATI account — sends included, in Test and Live mode alike (it's the account, not the mode). Every WATI API call counts toward a monthly quota (Growth plan: 10,000 a month; it resets on the 1st), and the EMR's own lab-report messages use the same account.
What the app does: stops status checks, pauses automatic retries (1 h, then 3 h, 6 h), and re-sends every refused report automatically once WATI accepts again. Staff don't need to click again.
To send sooner: ask WATI support to reset or raise the limit (more quota needs the Business plan). To prevent it: connect the WATI webhook (Monitor → WATI connection) so status checks aren't needed; status checks are capped at 100 calls a day.`,
  },
  {
    id: 'plugin-not-supported',
    title: '"This plugin is not supported" in WATI inbox',
    keywords: 'plugin not supported wati inbox pdf preview not showing document blank http https link expired',
    text: `In WATI's Team Inbox the PDF shows "This plugin is not supported" when its link is plain http (WATI's page is https, so the browser blocks it) or has expired. The patient still gets the PDF — WhatsApp downloads it when the message is sent. Fix: serve the app over https and set PUBLIC_BASE_URL (e.g. https://194-238-22-210.sslip.io); new links are then https and stay valid 2 days. The Monitor's WATI connection card shows whether links are https.`,
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
    keywords: 'monitor admin whatsapp monitor dashboard analytics live check wati now presets today yesterday filters tiles charts kpi dates by report date sent date discharged count wrong more patients',
    text: `The WhatsApp Monitor (the Monitor tab, or /admin) tracks every message:
- Header: "Live · updated …" (refreshes every 15 s), when WATI was last checked or that it's paused, and "Check WATI now" (asks WATI for the latest ticks; max once per 5 min).
- Filters in one row: date presets (Today, Yesterday — the default, Last 7 days, Last 30 days, This month, Custom), "Dates by", status chips, document, trigger (automatic / manual click / share / retry) and search by name, IP or number.
- Time: optional from–to time of day (India time). With Report date it's the patient's discharge time from the EMR ("today 10:00–14:00" = patients discharged then); with Sent date it's when the message went out. × clears it.
- "Dates by": Report date (default) counts patients by discharge date — the date their reports are filed under — so Today = today's patients only. Sent date counts by when the message went out, so Today also includes earlier patients' reports sent or re-sent today (e.g. after a WATI limit). Tiles, charts, lists and exports all follow it; the line under the filters says which is used.
- Tiles: Triggered, Sent, Delivered, Read, Pending, Failed — each with a trend and the change vs the previous period.
- WATI connection card, Coverage (discharged patients: sent / not sent / no mobile / no report yet), Needs attention (failed — can be fixed, not on WhatsApp, unread 24 h+, one tick 6 h+).
- Charts: Messages over time, Delivery & read rate, When patients open reports, How long until read, Status by trigger, Why messages fail, By department, Who clicked.
- Live activity feed and the Patients / Messages table (click a row for its timeline and Retry now). Export to Excel, PDF, CSV or JSON.`,
  },
  {
    id: 'wati-connection-card',
    title: 'Monitor → WATI connection card',
    keywords: 'wati connection card api calls today month status checks webhook connected pdf links green amber red',
    text: `Three tiles: "API calls from this app" (today's sends and status checks out of the daily allowance, this month's total, and a red warning while WATI refuses calls with the time it resumes), "Delivered / read updates" (green when the WATI webhook is connected; otherwise status checks are used — "Connect the webhook" shows the steps and the URL to copy), and "PDF links" (green when links are https; amber for plain http). Counts cover this app only, not the EMR's own WATI use.`,
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
    text: `"Not on WhatsApp" means WATI/WhatsApp said the patient's mobile has no WhatsApp account (or it's mistyped). These aren't retried. Check and correct the mobile number in the EMR; the card shows a red "Not on WhatsApp" badge next to the mobile, and the Monitor lists them under Needs attention.`,
  },
  {
    id: 'no-lab-data',
    title: 'No lab data / no report',
    keywords: 'no lab data no lab report missing lab report why not generated empty failed generate',
    text: `"No lab data" means the EMR has no lab orders for that patient's stay (checked by IP and UHID, from a week before admission) — nothing is wrong and it won't be re-checked. "failed" in the stat chips means a PDF couldn't be built; it's retried at the next 15-minute check.`,
  },
  {
    id: 'ask-ai',
    title: 'Ask AI (this assistant)',
    keywords: 'ask ai assistant chat help what can you do privacy data sent',
    text: `Ask AI (bottom right, for accounts with Ask AI turned on) can: find a patient's reports (IP number, UHID or name) with download and WhatsApp options; list discharges for a date; search lab results across patients (e.g. "urine glucose negative last week") and export them; take you to a screen; explain any screen, button or colour; and report live status — WATI quota and pauses, webhook, Test/Live mode, the 15-minute check, WhatsApp sent/delivered/read/failed counts and why a patient's message failed. Patient names and lab values stay in the portal; the AI service only sees counts and IDs. If the AI service is busy it answers from built-in rules.`,
  },
  {
    id: 'users-access',
    title: 'Users and access (super admin)',
    keywords: 'user users account accounts add create staff role roles permission permissions access rbac super admin screen read only write edit disable delete reset password hours schedule preset doctor nurse front desk lab viewer',
    text: `The super admin (the login in the server .env) manages everyone on the Users screen:
- Add user: profile (name, username, designation, department, mobile, email, password — Generate makes one), then a role preset (Admin, Doctor, Nurse / ward staff, Lab staff, Front desk, View only) and adjust.
- Screens: tick each screen the person may open, then View only, or View & send (View & edit on WATI Settings). View & send on Discharge Reports = Check Now and sending WhatsApp; on Lab Finder = sharing on WhatsApp; on the Monitor = Retry and "Check WATI now". View & edit on WATI Settings = changing mode, number and extra line. Lab Search is look-up only.
- Ask AI: Off, Ask questions, or Ask + send (share / test messages). It only ever shows what the person's screens allow.
- WhatsApp button on patient cards: on or off (needs Discharge Reports View & send).
- Reports shown: Both, Lab report only, or Discharge summary only — also limits what they can send.
- Access hours: days and a from–to time (India time; overnight works). Outside them they can't sign in and an open session ends.
- On the list: the switch disables an account; the key sets a new password; the arrow signs them out on every device; the bin deletes. Too many wrong passwords lock an account for a while (Master Settings → Sign-in & security; the lock icon unlocks it).
Changes apply from the person's next click. Every rule is checked by the server too, not just hidden. Master Settings switches (e.g. the WhatsApp button or Ask AI off for everyone, read-only mode) sit above each person's own access.`,
  },
  {
    id: 'audit-log',
    title: 'Audit Log',
    keywords: 'audit log activity who did what when track tracking sign in sign out login logout session idle inactive tab away time clicks cancelled popup ai chats history department user report',
    text: `The Audit Log (tab "Audit Log"; super admin, or anyone given access) records who did what and when: sign-ins (and failed ones), sign-outs and session length, every screen opened, discharge dates viewed, filters used, IDs copied, PDFs opened, each WhatsApp click — and whether the popup was sent (to which number, edited or not) or cancelled — retries, exports, settings and user changes, and every Ask AI question with its answer. Each session shows active time, idle time (no mouse or keyboard for 5+ minutes) and time away from the tab.
Views: Timeline (click a row for details, a person to see only them, "Show this session"), People, Departments, Sessions (online now, signed out or closed without signing out) and AI chats (full conversations). Filter by dates, person, department, type and text; "Show tab switches & idle" adds those events. Download as Excel or CSV. How long records are kept, and whether tab switches and idle time are recorded, is set in Master Settings → Audit log (default a year). Opening or downloading the audit log is itself logged; so is every Master Settings change.`,
  },
  {
    id: 'my-profile',
    title: 'My profile and password',
    keywords: 'my profile password change forgot locked sign out account hours my access',
    text: `Click your name at the top right: it shows your access and access hours. Change password asks for the current one and signs you out on other devices. Passwords are stored encrypted — nobody, not even the super admin, can see them. Forgot it, or locked after five wrong tries? Ask the super admin to reset it: they set a temporary password, and when you sign in with it you choose your own before anything else, so only you know it. The super admin's own password is set in the server .env (APP_PASSWORD).`,
  },
  {
    id: 'op-lookup',
    title: 'Lab reports for OP patients / UHIDs not in the discharge list (Ask AI)',
    keywords: 'op out patient outpatient uhid not found lab report emr fetch find search any patient whatsapp send number pdf download',
    text: `The portal is built around discharged IP patients; OP patients never appear in Discharge Reports, Lab Finder or the Monitor's patient lists. In Ask AI only, you can get any patient's lab report straight from the EMR lab: ask e.g. "find UHID 6159338" — if it isn't a discharged patient, Ask AI searches the EMR lab (the last few weeks by default — Master Settings → Ask AI; say "last 6 months" or dates for more) and makes the lab report PDF. Then Open, Download, or WhatsApp: give the number (it warns if it's e.g. only 9 digits), press Send, and the card shows whether it was sent, delivered but not read, read, or that the number isn't on WhatsApp ("Check with WATI" asks for the latest). It's sent with the template chosen in WATI Settings (Template for Ask AI lab reports). Needs Lab Search access; sending needs Ask AI "Ask + send".`,
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
    keywords: 'report reports generate make create table download excel pdf csv json patient wise message wise time between hours am pm discharge list count department doctor',
    text: `Ask AI builds reports on request, with any dates and times, shown as a table with downloads:
- WhatsApp report (needs WhatsApp Monitor access): e.g. "today 10 am to 2 pm WhatsApp report patient and message wise", "failed messages yesterday", "WhatsApp sent between 6 pm and 9 pm". Patient-wise and Message-wise tabs; download Excel, PDF, CSV or JSON; "Open in WhatsApp Monitor" opens the Monitor with the same filters. By default it counts patients by discharge date / time; say "sent" to count by send time.
- Discharge report (needs Discharge Reports access): e.g. "patients discharged today 10 am to 2 pm", "ENT discharges this week with No Summary", "Dr. Samson's patients yesterday not sent on WhatsApp". Totals, departments, each patient's lab report / summary / WhatsApp status; download Excel, PDF or CSV.
Times are India time; "8 pm to 8 am" means overnight from the evening before.`,
  },
  {
    id: 'ai-patient-answers',
    title: 'Ask AI: patient details, journey, compare, files',
    keywords: 'find search patient by phone mobile number who has belongs details whatsapp number mobile age address discharge time format journey flowchart timeline compare comparison two patients two reports change pdf csv excel group results combine file number #1 #2',
    text: `Ask AI answers with the patient's own data. Find a patient by anything — "find the patient with phone 89396 05869", "who is from Tindivanam", "gugan priyan", a UHID, IP number or lab Req No; it searches every discharge date, best match first, and says what matched:
- Details: "WhatsApp number and discharge time of IP07028684 in 12-hour format", "age and address of UHID 6176487" — mobile, age, gender, address, city, relation, email, diagnosis, admission / discharge date and time, length of stay, doctor, ward, bed, reports, WhatsApp status, out-of-range lab values (from the EMR discharge list).
- Journey: "patient journey of IP…" — a flowchart from admission, lab test days and discharge to reports made, WhatsApp sent / delivered / read and staff actions.
- Compare: "compare IP… and IP…" (two patients side by side) or "compare the lab reports of IP… first vs last day" — every test with both values and the change.
- Files: every table or card in a chat is numbered #1, #2 …; ask "put #1 and #2 in one PDF and #3 in a CSV", "everything in one PDF", "first two in Excel" (add "with answers" to include the questions and replies).
Patient details are sent to the AI service to answer (Master Settings → Ask AI → "Let the AI service read patient details"; ABHA ID and religion never are).`,
  },
  {
    id: 'exports',
    title: 'Downloads and exports',
    keywords: 'download export excel xlsx pdf word docx csv json file format',
    text: `Lab Finder and Ask AI results download as PDF, Excel (.xlsx), Word (.docx) or CSV; a single patient's PDFs open from the Lab Report / Summary buttons. The WhatsApp Monitor exports messages or patients as Excel, PDF, CSV or JSON for the selected dates and filters. If the download buttons are missing, downloads are switched off for everyone in Master Settings (or read-only mode is on).`,
  },
  {
    id: 'master-settings',
    title: 'Master Settings (super admin)',
    keywords: 'master settings setting configure configuration control options switch toggle global everyone hide whatsapp button icon disable feature retry hours days interval timing announcement banner notice maintenance read only lock idle sign out session password length audit retention refresh',
    text: `Settings tab (gear icon, /settings) — super admin only. Every switch and timing of the portal in one place; changes apply to everyone as soon as you save, and open screens update within a minute.
- At a glance: WhatsApp mode, retries, the discharge check and the portal state; click one to jump to its section.
- Features for everyone: switch off for all staff at once, above their own access — WhatsApp button on patient cards, Ask AI, Ask AI sending, Ask AI EMR lookup (OP), Lab Search, Lab Finder, downloads & exports. Each shows how many staff have it. The super admin always keeps everything.
- WhatsApp sending: send automatically in Live mode (off = Live mode only for the WhatsApp button), how many days the PDF link works. Live / Test mode, test number and templates stay on WATI Settings.
- Automatic retries: on/off, also retry "Not on WhatsApp", retry every N hours, for N days, quick first retry, daily cap — with a timeline showing every try (e.g. every 6 hours for 3 days = 12 tries, 4 a day).
- WATI API usage: status checks for ticks on/off and per day, with today's usage meters.
- Discharge automation: check the EMR automatically (pause), how often (5–60 min), and how often Discharge Reports refreshes.
- Sign-in & security: session length, sign out after no activity (shared computers), wrong-password lockout and minutes, shortest password.
- Ask AI: let the AI read patient details, how far back the EMR lookup searches.
- Audit log: keep records for N days, record tab switches and idle time.
- Announcement & maintenance: a message at the top of every screen (blue / amber / red, preview shown) and read-only mode (staff can view only; no sending, retries, downloads or changes; automatic sending pauses).
How to use: change values (they're marked "Unsaved"), then Review & save — the review lists each change from → to with what it will do. Discard drops them; "Reset to default" per setting or per section; search finds a setting; "Changed from default" shows only what's been changed. Change history lists who changed what and when (also in the Audit Log).`,
  },
  {
    id: 'it-admin',
    title: 'For IT: deploy, scripts and settings',
    keywords: 'it admin deploy vps docker compose update pull build script regenerate backfill env settings https nginx certbot server restart',
    text: `VPS: /docker/investigation-chart. Update: git pull, then docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build.
Scripts (inside the backend container, docker exec investigation-backend node src/scripts/…): regenerateReports.js (rebuild recent PDFs), regenerateDischargeSummaries.js, backfillLabResults.js --all (store lab values for Lab Finder).
Root .env settings: PUBLIC_BASE_URL (https address for PDF links), WHATSAPP_LINK_DAYS (default 2), WATI_STATUS_CHECKS_PER_DAY (default 100), MINIO_PUBLIC_ENDPOINT, GROQ_API. HTTPS on this VPS is a site in the host nginx proxying to 127.0.0.1:1003, with a certbot certificate.`,
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
