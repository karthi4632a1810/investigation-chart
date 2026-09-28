/**
 * Letterhead and patient-details block shared by both generated PDFs — the lab
 * report (investigationPdfService.js) and the discharge summary
 * (dischargeSummaryService.js) — so the two documents read as one set.
 *
 * Every class is `pi-` prefixed: the discharge summary is rendered inside the
 * EMR's own page, whose stylesheet must not collide with ours.
 *
 * Fonts: only what the server's Chromium has (Alpine's ttf-freefont) — no web
 * fonts, no emoji (they render as "?" boxes there). IDs use tabular figures
 * rather than a monospace face, which is thin and uneven in FreeMono.
 */
import fs from 'fs';

export function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function loadAssetDataUri(relPath) {
  try {
    const file = new URL(relPath, import.meta.url);
    if (fs.existsSync(file)) {
      return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
    }
  } catch {
    // fall through to empty string — caller omits the <img> entirely
  }
  return '';
}

const logoDataUri = loadAssetDataUri('../assets/logo.png');
const nablBadgeDataUri = loadAssetDataUri('../assets/nabl.png');
const nabhBadgeDataUri = loadAssetDataUri('../assets/nabh.png');

/** DD-MM-YYYY (the chart's own date format) in hospital time — the server may run in UTC. */
export function formatGeneratedDate(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day}-${parts.month}-${parts.year}`;
}

/**
 * Brand bar, hospital identity + accreditation badges, then a dark title band
 * naming the document. A single root element — the discharge summary moves
 * `firstElementChild` of this markup into the EMR page.
 */
export function letterheadHtml(hospital, { title, subtitle = '', meta = '' }) {
  const logoSrc = logoDataUri || hospital?.logoPath || '';
  const badges = [
    nablBadgeDataUri ? `<img src="${nablBadgeDataUri}" alt="NABL Accredited Laboratory" />` : '',
    nabhBadgeDataUri ? `<img src="${nabhBadgeDataUri}" alt="NABH Accredited Hospital" />` : '',
  ].join('');

  return `
    <div class="pi-letterhead-wrap">
      <div class="pi-brand-bar"></div>
      <div class="pi-letterhead">
        <div class="pi-lh-logo">${logoSrc ? `<img src="${esc(logoSrc)}" onerror="this.style.display='none'" />` : ''}</div>
        <div class="pi-lh-name">
          <div class="pi-hosp-name-en">${esc(hospital?.nameEn || 'Adhiparasakthi Hospitals')}</div>
          <div class="pi-hosp-name-ta">${esc(hospital?.nameTa || 'ஆதிபராசக்தி மருத்துவமனை')}</div>
          <div class="pi-hosp-address">${hospital?.address || ''}</div>
        </div>
        ${
          badges
            ? `<div class="pi-lh-accred"><div class="pi-accred-badges">${badges}</div><div class="pi-accred-caption">NABL Lab · NABH Accredited</div></div>`
            : ''
        }
      </div>
      <div class="pi-doc-title">
        <div>
          <div class="pi-doc-title-text">${esc(title)}</div>
          ${subtitle ? `<div class="pi-doc-title-sub">${esc(subtitle)}</div>` : ''}
        </div>
        ${meta ? `<div class="pi-doc-title-meta">${esc(meta)}</div>` : ''}
      </div>
    </div>`;
}

/**
 * Name + tags on top, then one row of identifiers (UHID first) and any further
 * rows of details. `fields`: [{ label, value, id?: true (tabular ID styling),
 * key?: true (highlighted tile), wide?: true (spans two columns) }].
 * `tags`: [{ text, tone?: 'blue' | 'green' | 'rose' }].
 */
export function patientCardHtml({ name, tags = [], fields = [] }) {
  const tagHtml = tags
    .filter((t) => String(t.text || '').trim())
    .map((t) => `<span class="pi-tag${t.tone ? ` pi-tag-${t.tone}` : ''}">${esc(t.text)}</span>`)
    .join('');
  const fieldHtml = fields
    .map((f) => {
      const hasVal = String(f.value ?? '').trim() !== '';
      const cls = ['pi-field', f.key ? 'is-key' : '', f.wide ? 'is-wide' : ''].filter(Boolean).join(' ');
      const valCls = ['pi-field-val', f.id ? 'is-id' : '', hasVal ? '' : 'is-blank'].filter(Boolean).join(' ');
      return `<div class="${cls}"><span class="pi-field-label">${esc(f.label)}</span><span class="${valCls}">${hasVal ? esc(f.value) : '—'}</span></div>`;
    })
    .join('');

  return `<div class="pi-patient-card">
    <div class="pi-patient-top">
      <div class="pi-patient-id">
        <div class="pi-eyebrow">Patient</div>
        <div class="pi-patient-name">${esc(name || 'Patient Record')}</div>
      </div>
      ${tagHtml ? `<div class="pi-patient-tags">${tagHtml}</div>` : ''}
    </div>
    <div class="pi-patient-grid">${fieldHtml}</div>
  </div>`;
}

/** EMR names sometimes carry stray trailing punctuation ("SIRANJEEVI. D ,"). */
export function cleanPatientName(name) {
  return String(name || '').replace(/[\s,;:]+$/, '').trim();
}

export const BRAND_CSS = `
  .pi-letterhead-wrap { margin-bottom: 10px; break-inside: avoid; }
  .pi-brand-bar {
    height: 4px;
    border-radius: 2px;
    margin-bottom: 10px;
    background: linear-gradient(90deg, #0b2956 0%, #1d4ed8 65%, #0d9488 100%);
  }
  .pi-letterhead { display: flex; align-items: center; gap: 14px; padding-bottom: 10px; }
  .pi-lh-logo { width: 50px; height: 70px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; }
  .pi-lh-logo img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .pi-lh-name { flex: 1 1 auto; min-width: 0; }
  .pi-hosp-name-en { font-size: 19px; font-weight: 800; color: #0b2956; letter-spacing: -0.015em; line-height: 1.15; }
  .pi-hosp-name-ta { font-size: 12px; font-weight: 700; color: #1d4ed8; margin-top: 2px; line-height: 1.2; }
  .pi-hosp-address { font-size: 7.8px; color: #64748b; margin-top: 4px; line-height: 1.55; }
  .pi-lh-accred { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
  .pi-accred-badges { display: flex; align-items: center; gap: 6px; }
  .pi-accred-badges img { height: 34px; width: auto; object-fit: contain; }
  .pi-accred-caption { font-size: 6.8px; font-weight: 700; color: #64748b; letter-spacing: 0.06em; text-transform: uppercase; }

  .pi-doc-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 14px;
    border-radius: 8px;
    background: #0b2956;
  }
  .pi-doc-title-text { font-size: 13px; font-weight: 800; color: #ffffff; letter-spacing: 0.14em; text-transform: uppercase; line-height: 1.2; }
  .pi-doc-title-sub { font-size: 8px; font-weight: 500; color: #bfdbfe; margin-top: 2px; letter-spacing: 0.02em; }
  .pi-doc-title-meta { font-size: 8px; font-weight: 600; color: #dbeafe; text-align: right; white-space: nowrap; }

  .pi-patient-card {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 10px 12px;
    margin: 0 0 10px 0;
    break-inside: avoid;
  }
  .pi-patient-top {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 12px;
    padding-bottom: 8px;
    margin-bottom: 8px;
    border-bottom: 1px solid #eef2f7;
  }
  .pi-patient-id { min-width: 0; }
  .pi-eyebrow { font-size: 7px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; }
  .pi-patient-name { font-size: 15px; font-weight: 800; color: #0f172a; letter-spacing: -0.01em; line-height: 1.2; margin-top: 1px; overflow-wrap: anywhere; }
  .pi-patient-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
  .pi-tag {
    font-size: 8.5px;
    font-weight: 700;
    padding: 2.5px 9px;
    border-radius: 999px;
    background: #f1f5f9;
    border: 1px solid #e2e8f0;
    color: #334155;
    white-space: nowrap;
  }
  .pi-tag-blue { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }
  .pi-tag-green { background: #ecfdf5; border-color: #a7f3d0; color: #047857; }
  .pi-tag-rose { background: #fff1f2; border-color: #fecdd3; color: #be123c; }

  .pi-patient-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
  .pi-field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 5px 8px;
    background: #f8fafc;
    border: 1px solid #eef2f7;
    border-radius: 6px;
  }
  .pi-field.is-key { background: #eff6ff; border-color: #bfdbfe; }
  .pi-field.is-wide { grid-column: span 2; }
  .pi-field-label { font-size: 7px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; }
  .pi-field-val { font-size: 10px; font-weight: 700; color: #0f172a; line-height: 1.3; overflow-wrap: anywhere; }
  .pi-field-val.is-id { font-size: 11px; font-weight: 800; color: #1d4ed8; letter-spacing: 0.03em; font-variant-numeric: tabular-nums; }
  .pi-field-val.is-blank { color: #cbd5e1; font-weight: 500; }
`;
