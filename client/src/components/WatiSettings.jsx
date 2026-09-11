import { useEffect, useState } from 'react';
import { fetchWatiSettings, updateWatiSettings } from '../api/client';
import { WhatsAppIcon } from './Icons';

export default function WatiSettings() {
  const [settings, setSettings] = useState(null);
  const [fixedNumberInput, setFixedNumberInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchWatiSettings()
      .then((s) => {
        setSettings(s);
        setFixedNumberInput(s.fixedNumber || '');
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  async function persist(patch) {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const updated = await updateWatiSettings(patch);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function handleToggle() {
    persist({ liveEnabled: !settings.liveEnabled });
  }

  function handleSaveFixedNumber(e) {
    e.preventDefault();
    persist({ fixedNumber: fixedNumberInput });
  }

  if (loading) {
    return <div className="search-view-container"><div className="loading modern-loading"><div className="spinner"></div><div>Loading WATI settings…</div></div></div>;
  }

  return (
    <div className="search-view-container">
      <div className="section-header">
        <h2>WhatsApp (WATI) Settings</h2>
        <p className="section-subtitle">
          Controls whether lab reports send automatically to patients over WhatsApp, or stay in manual
          test mode.
        </p>
      </div>

      <div className="wati-settings-card">
        <div className="wati-toggle-row">
          <div className="wati-toggle-label">
            <WhatsAppIcon size={20} />
            <div>
              <div className="wati-toggle-title">WATI Live</div>
              <div className="wati-toggle-desc">
                {settings.liveEnabled
                  ? 'ON — new lab reports auto-send to each patient’s own mobile number. The manual button also sends to the real patient.'
                  : 'OFF — nothing sends automatically. The manual button sends to the fixed test number below instead of real patients.'}
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`wati-toggle-switch ${settings.liveEnabled ? 'on' : 'off'}`}
            onClick={handleToggle}
            disabled={saving}
            role="switch"
            aria-checked={settings.liveEnabled}
          >
            <span className="wati-toggle-knob" />
          </button>
        </div>

        {!settings.liveEnabled && (
          <form className="wati-fixed-number-form" onSubmit={handleSaveFixedNumber}>
            <label htmlFor="wati-fixed-number">Fixed test number</label>
            <div className="wati-fixed-number-row">
              <input
                id="wati-fixed-number"
                type="tel"
                placeholder="e.g. 9384508490"
                value={fixedNumberInput}
                onChange={(e) => setFixedNumberInput(e.target.value)}
              />
              <button type="submit" className="btn btn-primary" disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <p className="wati-fixed-number-hint">
              While live mode is off, every manual "Send WhatsApp" click on the Discharge Reports screen
              goes to this number instead of the patient's own — safe for testing the whole flow without
              messaging real patients.
            </p>
          </form>
        )}

        {saved && <div className="wati-save-toast">Saved</div>}
        {error && <div className="error modern-error-alert"><div className="alert-icon">⚠️</div><div className="alert-body">{error}</div></div>}
      </div>
    </div>
  );
}
