import { Fragment, useEffect, useState } from 'react';
import ChartEditPanel from './ChartEditPanel';
import {
  buildLayoutFromTemplate,
  clearSavedLayout,
  loadSavedLayout,
  mergeLayoutWithTemplate,
  saveLayout,
  sectionsWithValuesFromLayout,
} from '../utils/chartLayout';

function PatientField({ label, value }) {
  const hasVal = String(value || '').trim() !== '';
  return (
    <div className="pf">
      <span>{label}</span>
      <b className={hasVal ? '' : 'blank'}>{hasVal ? value : '—'}</b>
    </div>
  );
}

function ValueCell({ val, range, isOutOfRange, isPending }) {
  const out = isOutOfRange(val, range);
  const pending = isPending(val);
  const classes = ['field-value'];
  if (val) classes.push('filled');
  else classes.push('empty-val');
  if (out) classes.push('out-of-range');
  if (pending) classes.push('pending');
  return <td className={classes.join(' ')}>{val || '—'}</td>;
}

function ChartBody({ sections, dates, chartValues, isOutOfRange, isPending }) {
  return sections.map(({ sectionName, fields }) => (
    <Fragment key={sectionName}>
      <tr className="section-row">
        <td colSpan={2 + dates.length}>{sectionName}</td>
      </tr>
      {fields.map((field) => (
        <tr key={field.id}>
          <td className="field-label">{field.label}</td>
          <td className="field-range">{field.range}</td>
          {dates.map((d) => {
            const val = chartValues[field.id]?.[d] ?? '';
            return (
              <ValueCell
                key={d}
                val={val}
                range={field.range}
                isOutOfRange={isOutOfRange}
                isPending={isPending}
              />
            );
          })}
        </tr>
      ))}
    </Fragment>
  ));
}

export default function InvestigationChart({
  hospital,
  regNo,
  chart,
  editOpen = false,
  onEditOpenChange,
}) {
  const [layout, setLayout] = useState([]);
  const setEditOpen = onEditOpenChange || (() => {});

  const template = chart?.template;

  useEffect(() => {
    if (!template) return;
    const saved = loadSavedLayout();
    setLayout(mergeLayoutWithTemplate(saved, template));
  }, [template]);

  if (!chart?.chartDates?.length) {
    return <div className="empty">Could not build the chart (no Req No / dates detected).</div>;
  }

  const { chartDates, chartValues, unmapped, patientMeta } = chart;

  function parseNumber(v) {
    const n = parseFloat(String(v).replace(/[^0-9.+\-eE]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function isOutOfRange(valRaw, rangeStr) {
    const val = parseNumber(valRaw);
    if (val === null || !rangeStr) return false;

    const r = String(rangeStr).trim();
    const dash = r.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
    if (dash) {
      const min = parseFloat(dash[1]);
      const max = parseFloat(dash[2]);
      return val < min || val > max;
    }

    const lt = r.match(/^<\s*(-?\d+(?:\.\d+)?)/);
    if (lt) return val >= parseFloat(lt[1]);
    const gt = r.match(/^>\s*(-?\d+(?:\.\d+)?)/);
    if (gt) return val <= parseFloat(gt[1]);

    return false;
  }

  function isPending(val) {
    if (val == null) return false;
    return String(val).toLowerCase().includes('pending');
  }

  function handleLayoutChange(next) {
    setLayout(next);
    saveLayout(next);
  }

  function handleReset() {
    clearSavedLayout();
    const fresh = buildLayoutFromTemplate(template);
    setLayout(fresh);
  }

  const screenSections = sectionsWithValuesFromLayout(layout, chartValues, chartDates);

  const PRINT_CHUNK = 6;
  const dateChunks = [];
  for (let i = 0; i < chartDates.length; i += PRINT_CHUNK) {
    dateChunks.push(chartDates.slice(i, i + PRINT_CHUNK));
  }

  return (
    <div className={`chart-card ${editOpen ? 'chart-edit-open' : ''}`}>
      <div className="letterhead">
        <div className="letterhead-logo">
          {hospital?.logoPath && (
            <img
              src={hospital.logoPath}
              alt="Hospital Logo"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
        </div>
        <div className="letterhead-name">
          <div className="hosp-name-en">{hospital?.nameEn}</div>
          <div className="hosp-name-ta">{hospital?.nameTa}</div>
          {hospital?.address && (
            <div
              className="hosp-address"
              dangerouslySetInnerHTML={{ __html: hospital.address }}
            />
          )}
        </div>
        <div className="letterhead-title">
          <div className="chart-title-main">INVESTIGATION CHART</div>
          <div className="chart-regno">UHID: {regNo}</div>
        </div>
      </div>

      <div className="patient-strip">
        <PatientField label="Patient Name" value={patientMeta?.name} />
        <PatientField label="Age" value={patientMeta?.age} />
        <PatientField label="Sex" value={patientMeta?.sex} />
        <PatientField label="Bed No" value={patientMeta?.bed} />
        <PatientField label="IP No" value={patientMeta?.ip} />
        <PatientField label="Ward" value={patientMeta?.ward} />
        <PatientField label="Unit" value={patientMeta?.unit} />
      </div>

      <div className="chart-card-body">
        {screenSections.length === 0 ? (
          <div className="empty">No mapped result values to show in the chart.</div>
        ) : (
          <table className="chart">
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Parameter</th>
                <th style={{ minWidth: 140 }}>Ref. Range</th>
                {chartDates.map((d) => (
                  <th key={d}>{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <ChartBody
                sections={screenSections}
                dates={chartDates}
                chartValues={chartValues}
                isOutOfRange={isOutOfRange}
                isPending={isPending}
              />
            </tbody>
          </table>
        )}

        <div className="chart-print">
          {dateChunks.map((chunk, idx) => {
            const printSections = sectionsWithValuesFromLayout(layout, chartValues, chunk);
            if (!printSections.length) return null;

            return (
              <div key={idx} className="chart-print-page">
                <table className="chart chart-print-table">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 160 }}>Parameter</th>
                      <th style={{ minWidth: 140 }}>Ref. Range</th>
                      {chunk.map((d) => (
                        <th key={d}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <ChartBody
                      sections={printSections}
                      dates={chunk}
                      chartValues={chartValues}
                      isOutOfRange={isOutOfRange}
                      isPending={isPending}
                    />
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>

        {unmapped?.length > 0 && (
          <div className="unmapped-box">
            <h3>Unmapped results</h3>
            <div className="hint">
              These test results were fetched but don&apos;t match a template row yet — check the
              exact test name and add it as an alias in the chart template if it should map
              somewhere.
            </div>
            <table className="unmapped">
              <thead>
                <tr>
                  <th>Req No</th>
                  <th>Date</th>
                  <th>Test Name</th>
                  <th>Value</th>
                  <th>Range</th>
                </tr>
              </thead>
              <tbody>
                {unmapped.map((u, i) => (
                  <tr key={`${u.orderid}-${u.test}-${i}`}>
                    <td>{u.orderid}</td>
                    <td>{u.date}</td>
                    <td>{u.test}</td>
                    <td>{u.value}</td>
                    <td>{u.range}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ChartEditPanel
        open={editOpen}
        layout={layout}
        onClose={() => setEditOpen(false)}
        onChange={handleLayoutChange}
        onReset={handleReset}
      />
    </div>
  );
}
