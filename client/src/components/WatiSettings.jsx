import { useEffect, useState } from 'react';
import { fetchWatiSettings, saveMasterSettings, updateWatiSettings } from '../api/client';
import { AlertIcon, CheckIcon, FilePdfIcon, LockIcon, PhoneIcon, WhatsAppIcon } from './Icons';

// OP sends only the OP Lab Report PDF over WhatsApp — mirrors WHATSAPP_DOCUMENTS on the server.
const DOCUMENTS = [
  { label: 'Lab Report', file: 'Lab-Report.pdf' },
];

/** The template's {{2}} line — same format as documentLine() in watiService.js. */
function documentLine(label, extra) {
  const text = String(extra || '').trim();
  return text ? `Attached: ${label} — ${text}` : `Attached: ${label}`;
}

/** Renders the approved WATI template body matching watiService.js. */
function TemplatePreviewBody({ template, docLabel, secondParam }) {
  if (template === 'mapims_lab_rpt') {
    return (
      <>
        Dear <b>Patient name</b>,{'\n\n'}Your laboratory report is ready.{'\n\n'}Please find your report attached.
        {'\n\n'}If you have any questions, please contact the laboratory.{'\n\n'}Thank you,{'\n'}Adhiparasakthi
        Hospital
      </>
    );
  }
  return (
    <>
      Dear <b>Patient name</b>,{'\n\n'}Your investigation report is ready.{'\n\n'}Please find the report attached.
      {template === 'investigation' ? (
        <>
          {'\n'}
          <mark>{documentLine(docLabel, secondParam)}</mark>
        </>
      ) : null}
      {'\n'}For any assistance, please contact Adhiparasakthi Hospital.{'\n\n'}Thank you.
    </>
  );
}

/** Same normalisation as toWatiNumber() on the server: 10 digits get +91. */
function toWhatsAppDigits(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits;
}

function formatWhatsAppNumber(raw) {
  const d = toWhatsAppDigits(raw);
  return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : d ? `+${d}` : '';
}

function isValidNumber(raw) {
  const d = toWhatsAppDigits(raw);
  return d.length >= 11 && d.length <= 15;
}

function SavedTick({ show }) {
  return show ? (
    <span className="wati-saved" role="status">
      <CheckIcon size={14} /> Saved
    </span>
  ) : null;
}

export default function WatiSettings({ readOnly = false, appSettings = {}, isSuperAdmin = false, onNavigate, onAppSettingsChange }) {
  const [settings, setSettings] = useState(null);
  const [fixedNumberInput, setFixedNumberInput] = useState('');
  const [secondParamInput, setSecondParamInput] = useState('');
  const [usePdfTemplate, setUsePdfTemplate] = useState(Boolean(appSettings['opReports.usePdfTemplate']));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [savedField, setSavedField] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setUsePdfTemplate(Boolean(appSettings['opReports.usePdfTemplate']));
  }, [appSettings]);

  useEffect(() => {
    fetchWatiSettings()
      .then((s) => {
        setSettings(s);
        setFixedNumberInput(s.fixedNumber || '');
        setSecondParamInput((s.secondParam || '').trim());
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function persist(field, patch) {
    if (readOnly) return;
    setSaving(field);
    setError('');
    setSavedField('');
    try {
      const updated = await updateWatiSettings(patch);
      setSettings(updated);
      setSavedField(field);
      setTimeout(() => setSavedField((f) => (f === field ? '' : f)), 2200);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  async function togglePdfTemplate(next) {
    if (readOnly || !isSuperAdmin) return;
    setSaving('pdfTemplate');
    setError('');
    setSavedField('');
    const prev = usePdfTemplate;
    setUsePdfTemplate(next);
    try {
      await saveMasterSettings({ 'opReports.usePdfTemplate': next });
      await onAppSettingsChange?.();
      setSavedField('pdfTemplate');
      setTimeout(() => setSavedField((f) => (f === 'pdfTemplate' ? '' : f)), 2200);
    } catch (err) {
      setUsePdfTemplate(prev);
      setError(err.message);
    } finally {
      setSaving('');
    }
  }

  if (loading) {
    return (
      <div className="search-view-container">
        <div className="loading modern-loading">
          <div className="spinner"></div>
          <div>Loading WhatsApp settings…</div>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="search-view-container">
        <div className="lock-error" role="alert">
          <AlertIcon size={16} />
          <span>{error || 'Could not load WhatsApp settings.'}</span>
        </div>
      </div>
    );
  }

  const live = settings.liveEnabled;
  const numberDirty = fixedNumberInput.trim() !== (settings.fixedNumber || '').trim();
  const numberValid = isValidNumber(fixedNumberInput);
  const messageDirty = secondParamInput.trim() !== (settings.secondParam || '').trim();
  const recipient = live ? "Each patient's own mobile" : formatWhatsAppNumber(settings.fixedNumber) || 'No test number set';

  return (
    <div className="search-view-container wati-page">
      <header className="wati-hero">
        <div className="wati-hero-icon">
          <WhatsAppIcon size={24} />
        </div>
        <div className="wati-hero-text">
          <h2>WhatsApp delivery</h2>
          <p>Send each OP patient&apos;s approved lab report on WhatsApp through WATI.</p>
        </div>
        <span className={`wati-mode-pill ${live ? 'is-live' : 'is-test'}`}>
          <span className="wati-mode-dot" />
          {live ? 'Live — sending to patients' : 'Test mode'}
        </span>
      </header>

      {error && (
        <div className="lock-error wati-error" role="alert">
          <AlertIcon size={16} />
          <span>{error}</span>
        </div>
      )}

      {readOnly && (
        <div className="readonly-banner" role="note">
          <LockIcon size={14} /> Read only — you can see these settings but not change them.
        </div>
      )}

      <div className="wati-grid">
        <fieldset className="wati-col wati-fieldset" disabled={readOnly}>
          <section className="wati-panel">
            <div className="wati-panel-head">
              <div>
                <h3>Delivery mode</h3>
                <p>Choose who receives the reports.</p>
              </div>
              <SavedTick show={savedField === 'mode'} />
            </div>

            <div className="wati-modes" role="radiogroup" aria-label="Delivery mode">
              <button
                type="button"
                role="radio"
                aria-checked={!live}
                className={`wati-mode ${!live ? 'is-selected' : ''}`}
                disabled={Boolean(saving)}
                onClick={() => {
                  setConfirmLive(false);
                  if (live) persist('mode', { liveEnabled: false });
                }}
              >
                <span className="wati-mode-radio" />
                <span className="wati-mode-title">Test mode</span>
                <span className="wati-mode-desc">
                  Nothing sends automatically. "Send WhatsApp" delivers to the test number below.
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={live}
                className={`wati-mode is-live-option ${live ? 'is-selected' : ''}`}
                disabled={Boolean(saving)}
                onClick={() => !live && setConfirmLive(true)}
              >
                <span className="wati-mode-radio" />
                <span className="wati-mode-title">Live</span>
                <span className="wati-mode-desc">
                  Every new report sends automatically to the patient's own mobile number.
                </span>
              </button>
            </div>

            {confirmLive && (
              <div className="wati-confirm" role="alertdialog" aria-labelledby="wati-confirm-title">
                <AlertIcon size={18} />
                <div className="wati-confirm-body">
                  <strong id="wati-confirm-title">Send reports to real patients?</strong>
                  <span>
                    From the next check, each newly approved OP lab report is sent to the patient&apos;s
                    own WhatsApp number, and &quot;Send WhatsApp&quot; also goes to the patient.
                  </span>
                  <div className="wati-confirm-actions">
                    <button type="button" className="btn btn-secondary" onClick={() => setConfirmLive(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="btn wati-btn-live"
                      disabled={Boolean(saving)}
                      onClick={async () => {
                        await persist('mode', { liveEnabled: true });
                        setConfirmLive(false);
                      }}
                    >
                      {saving === 'mode' ? 'Turning on…' : 'Turn on live'}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {!live && (
            <form
              className="wati-panel"
              onSubmit={(e) => {
                e.preventDefault();
                if (numberValid) persist('number', { fixedNumber: fixedNumberInput.trim() });
              }}
            >
              <div className="wati-panel-head">
                <div>
                  <h3>
                    <label htmlFor="wati-fixed-number">Test number</label>
                  </h3>
                  <p>Receives every manual send while test mode is on.</p>
                </div>
                <SavedTick show={savedField === 'number'} />
              </div>
              <div className="wati-input-row">
                <span className="wati-input">
                  <PhoneIcon size={15} />
                  <input
                    id="wati-fixed-number"
                    type="tel"
                    inputMode="tel"
                    placeholder="+91 99624 60782"
                    value={fixedNumberInput}
                    onChange={(e) => setFixedNumberInput(e.target.value)}
                  />
                </span>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!numberDirty || !numberValid || Boolean(saving)}
                >
                  {saving === 'number' ? 'Saving…' : 'Save'}
                </button>
              </div>
              <p className={`wati-hint ${fixedNumberInput && !numberValid ? 'is-invalid' : ''}`}>
                {fixedNumberInput && !numberValid
                  ? 'Enter a 10-digit mobile number, or one with its country code.'
                  : fixedNumberInput
                    ? `Messages go to ${formatWhatsAppNumber(fixedNumberInput)}. A 10-digit number is sent as +91.`
                    : 'A 10-digit number is sent as +91.'}
              </p>
            </form>
          )}

          <form
            className="wati-panel"
            onSubmit={(e) => {
              e.preventDefault();
              persist('message', { secondParam: secondParamInput.trim() });
            }}
          >
            <div className="wati-panel-head">
              <div>
                <h3>
                  <label htmlFor="wati-second-param">Extra message line</label>
                </h3>
                <p>Optional text added after the document name in the message.</p>
              </div>
              <SavedTick show={savedField === 'message'} />
            </div>
            <div className="wati-input-row">
              <span className="wati-input">
                <input
                  id="wati-second-param"
                  type="text"
                  maxLength={120}
                  placeholder="e.g. Get well soon"
                  value={secondParamInput}
                  onChange={(e) => setSecondParamInput(e.target.value)}
                />
              </span>
              <button type="submit" className="btn btn-primary" disabled={!messageDirty || Boolean(saving)}>
                {saving === 'message' ? 'Saving…' : 'Save'}
              </button>
            </div>
            <p className="wati-hint">Leave blank to send just &quot;Attached: Lab Report&quot;.</p>
            {live && secondParamInput.trim() && (
              <p className="wati-hint is-invalid" role="note">
                Live mode is on, so every patient reads this line. Clear it if it's a test note.
              </p>
            )}
          </form>

          <section className="wati-panel">
            <div className="wati-panel-head">
              <div>
                <h3>Before sending</h3>
                <p>For the WhatsApp button on a patient's card.</p>
              </div>
              <SavedTick show={savedField === 'confirm'} />
            </div>
            <label className="wati-toggle-row">
              <span>
                <b>Confirm the number first</b>
                <small>
                  Shows a popup with the number — {live ? "the patient's mobile (Live)" : 'the test number (Test mode)'} — which staff can check or change, then
                  Send.
                </small>
              </span>
              <input
                type="checkbox"
                className="wati-switch"
                checked={settings.confirmBeforeSend !== false}
                onChange={(e) => persist('confirm', { confirmBeforeSend: e.target.checked })}
              />
            </label>
          </section>

          <section className="wati-panel">
            <div className="wati-panel-head">
              <div>
                <h3>
                  <label htmlFor="wati-lab-template">OP lab report WATI template</label>
                </h3>
                <p>Used for automatic sends, manual OP report sends, retries, and Ask AI lab lookups.</p>
              </div>
              <SavedTick show={savedField === 'template'} />
            </div>
            <select
              id="wati-lab-template"
              className="wati-select"
              value={settings.labReportTemplate || 'mapims_lab_rpt'}
              onChange={(e) => persist('template', { labReportTemplate: e.target.value })}
            >
              <option value="mapims_lab_rpt">mapims_lab_rpt — &quot;Your laboratory report is ready&quot;</option>
              <option value="investigation_report">investigation_report — &quot;Your investigation report is ready&quot;</option>
              <option value="investigation">investigation — investigation report with the extra line</option>
            </select>
          </section>

          <section className="wati-panel">
            <div className="wati-panel-head">
              <div>
                <h3>
                  <label htmlFor="wati-use-pdf-template">Lab report PDF format</label>
                </h3>
                <p>Choose between the original hospital EMR report PDF and our custom colourful template.</p>
              </div>
              <SavedTick show={savedField === 'pdfTemplate'} />
            </div>
            <label className="wati-toggle-row" htmlFor="wati-use-pdf-template">
              <span>
                <b>Use PDF template</b>
                <small>
                  {usePdfTemplate
                    ? 'On — sends and opens our custom colourful lab report template PDF.'
                    : 'Off (default) — sends and opens only the original hospital lab report PDF from EMR.'}
                </small>
              </span>
              <input
                id="wati-use-pdf-template"
                type="checkbox"
                className="wati-switch"
                checked={usePdfTemplate}
                disabled={Boolean(saving) || !isSuperAdmin}
                onChange={(e) => togglePdfTemplate(e.target.checked)}
              />
            </label>
            <p className="wati-hint">
              {isSuperAdmin ? (
                <>
                  Synced with Master Settings &rarr; OP lab automation.{' '}
                  {onNavigate && (
                    <button type="button" className="ms-link" onClick={() => onNavigate('settings')}>
                      Open Master Settings
                    </button>
                  )}
                </>
              ) : (
                'Only a super admin can change this in Master Settings.'
              )}
            </p>
          </section>
        </fieldset>

        <aside className="wati-preview" aria-label="Message preview">
          <div className="wati-preview-title">
            <span>Message preview</span>
            <span className="wati-preview-to">To: {recipient}</span>
          </div>

          <div className="wati-phone">
            <div className="wati-phone-bar">
              <span className="wati-phone-avatar">
                <WhatsAppIcon size={16} />
              </span>
              <div>
                <div className="wati-phone-name">Adhiparasakthi Hospitals</div>
                <div className="wati-phone-sub">Business account</div>
              </div>
            </div>

            <div className="wati-chat">
              {DOCUMENTS.map((doc, i) => (
                <div className="wati-bubble" key={doc.label}>
                  <div className="wati-doc">
                    <span className="wati-doc-icon">
                      <FilePdfIcon size={18} />
                    </span>
                    <div className="wati-doc-text">
                      <div className="wati-doc-name">{doc.file}</div>
                      <div className="wati-doc-meta">PDF document</div>
                    </div>
                  </div>
                  <div className="wati-bubble-text">
                    <TemplatePreviewBody
                      template={settings.labReportTemplate || 'mapims_lab_rpt'}
                      docLabel={doc.label}
                      secondParam={secondParamInput}
                    />
                  </div>
                  <div className="wati-bubble-meta">
                    OP Lab Report · {settings.labReportTemplate || 'mapims_lab_rpt'}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <ul className="wati-rules">
            <li>Only generated &amp; sent once all active lab orders on that date are RESULT APPROVED.</li>
            <li>
              Active OP lab template: <code>{settings.labReportTemplate || 'mapims_lab_rpt'}</code>
              {settings.labReportTemplate === 'investigation' ? ' (includes extra message line).' : '.'}
            </li>
            <li>
              PDF format: <code>{usePdfTemplate ? 'Custom colourful template PDF' : 'Original EMR hospital PDF'}</code>
              {usePdfTemplate ? ' (Use PDF template is ON).' : ' (Use PDF template is OFF).'}
            </li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
