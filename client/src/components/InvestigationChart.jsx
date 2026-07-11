import { Fragment } from 'react';

function PatientField({ label, value }) {
  const hasVal = String(value || '').trim() !== '';
  return (
    <div className="pf">
      <span>{label}</span>
      <b className={hasVal ? '' : 'blank'}>{hasVal ? value : '—'}</b>
    </div>
  );
}

export default function InvestigationChart({ hospital, regNo, chart }) {
  if (!chart?.chartDates?.length) {
    return <div className="empty">Could not build the chart (no Req No / dates detected).</div>;
  }

  const { chartDates, chartValues, unmapped, patientMeta, template } = chart;

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

  const PRINT_CHUNK = 6;
  const dateChunks = [];
  for (let i = 0; i < chartDates.length; i += PRINT_CHUNK) {
    dateChunks.push(chartDates.slice(i, i + PRINT_CHUNK));
  }

  return (
    <div className="chart-card">
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
          <div className="chart-regno">Reg No: {regNo}</div>
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
            {Object.entries(template).map(([sectionName, fields]) => (
              <Fragment key={sectionName}>
                <tr className="section-row">
                  <td colSpan={2 + chartDates.length}>{sectionName}</td>
                </tr>
                {fields.map((field) => (
                  <tr key={field.id}>
                    <td className="field-label">{field.label}</td>
                    <td className="field-range">{field.range}</td>
                    {chartDates.map((d) => {
                      const val = chartValues[field.id]?.[d] ?? '';
                      const out = isOutOfRange(val, field.range);
                      const pending = isPending(val);
                      const classes = ['field-value'];
                      if (val) classes.push('filled');
                      else classes.push('empty-val');
                      if (out) classes.push('out-of-range');
                      if (pending) classes.push('pending');
                      return (
                        <td key={d} className={classes.join(' ')}>
                          {val || '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>

        { /* print-only chunked tables: hidden on screen, visible in print */ }
        <div className="chart-print">
          {dateChunks.map((chunk, idx) => (
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
                  {Object.entries(template).map(([sectionName, fields]) => (
                    <Fragment key={sectionName}>
                      <tr className="section-row">
                        <td colSpan={2 + chunk.length}>{sectionName}</td>
                      </tr>
                      {fields.map((field) => (
                        <tr key={field.id}>
                          <td className="field-label">{field.label}</td>
                          <td className="field-range">{field.range}</td>
                          {chunk.map((d) => {
                            const val = chartValues[field.id]?.[d] ?? '';
                            const out = isOutOfRange(val, field.range);
                            const pending = isPending(val);
                            const classes = ['field-value'];
                            if (val) classes.push('filled');
                            else classes.push('empty-val');
                            if (out) classes.push('out-of-range');
                            if (pending) classes.push('pending');
                            return (
                              <td key={d} className={classes.join(' ')}>
                                {val || '—'}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
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
    </div>
  );
}
