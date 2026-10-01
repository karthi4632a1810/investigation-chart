import { useEffect, useState } from 'react';
import { fetchWatiSettings, updateWatiSettings } from '../api/client';
import { AlertIcon, CheckIcon, FilePdfIcon, LockIcon, PhoneIcon, WhatsAppIcon } from './Icons';

// One message per document, in this order — mirrors WHATSAPP_DOCUMENTS on the server.
const DOCUMENTS = [
  { label: 'Lab Report', file: 'Lab-Report.pdf' },
  { label: 'Discharge Summary', file: 'Discharge-Summary.pdf' },
];

/** The template's {{2}} line — same format as documentLine() in watiService.js. */
function documentLine(label, extra) {
  const text = String(extra || '').trim();
  return text ? `Attached: ${label} — ${text}` : `Attached: ${label}`;
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

export default function WatiSettings({ readOnly = false }) {
  const [settings, setSettings] = useState(null);
  const [fixedNumberInput, setFixedNumberInput] = useState('');
  const [secondParamInput, setSecondParamInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [savedField, setSavedField] = useState('');
  const [confirmLive, setConfirmLive] = useState(false);
  const [error, setError] = useState('');

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
          <p>Send each patient's lab report and discharge summary on WhatsApp through WATI.</p>
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
                    From the next check, each new lab report and discharge summary is sent to the patient's
                    own WhatsApp number, and "Send WhatsApp" also goes to the patient.
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
                <p>Optional text added after the document name in both messages.</p>
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
            <p className="wati-hint">Leave blank to send just "Attached: Lab Report" / "Attached: Discharge Summary".</p>
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
                  <label htmlFor="wati-lab-template">Template for Ask AI lab reports</label>
                </h3>
                <p>Used when Ask AI sends a lab report it found in the EMR (OP patients too).</p>
              </div>
              <SavedTick show={savedField === 'template'} />
            </div>
            <select
              id="wati-lab-template"
              className="wati-select"
              value={settings.labReportTemplate || 'mapims_lab_rpt'}
              onChange={(e) => persist('template', { labReportTemplate: e.target.value })}
            >
              <option value="mapims_lab_rpt">mapims_lab_rpt — "Your laboratory report is ready"</option>
              <option value="investigation_report">investigation_report — "Your investigation report is ready"</option>
              <option value="investigation">investigation — same as discharge reports, with the extra line</option>
            </select>
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
                    Dear <b>Patient name</b>,{'\n\n'}Your investigation report is ready.{'\n\n'}Please find the report
                    attached.{'\n'}
                    <mark>{documentLine(doc.label, secondParamInput)}</mark>
                    {'\n'}For any assistance, please contact Adhiparasakthi Hospital.{'\n\n'}Thank you.
                  </div>
                  <div className="wati-bubble-meta">Message {i + 1} of 2</div>
                </div>
              ))}
            </div>
          </div>

          <ul className="wati-rules">
            <li>Each document is its own message — WhatsApp allows one file per template message.</li>
            <li>A discharge summary the EMR returned without patient data is never sent.</li>
            <li>Template: <code>investigation</code> (approved in WATI).</li>
          </ul>
        </aside>
      </div>
    </div>
  );
}
