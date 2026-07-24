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

function getStatusColor(val, rangeStr) {
  if (!val || !rangeStr || val === '—' || val === '--') return null;

  const cleanVal = String(val).replace(/[<>=\s]/g, '');
  const numVal = parseFloat(cleanVal);
  if (isNaN(numVal)) return null;

  const strRange = String(rangeStr);
  const rangeMatch = strRange.match(/([0-9.]+)\s*-\s*([0-9.]+)/);
  if (rangeMatch) {
    const min = parseFloat(rangeMatch[1]);
    const max = parseFloat(rangeMatch[2]);
    if (numVal < min) return 'red';
    if (numVal > max) return '#e67e22'; // Orange for above range
    return 'green';
  }

  const greaterMatch = strRange.match(/>\s*([0-9.]+)/);
  if (greaterMatch) {
    const limit = parseFloat(greaterMatch[1]);
    if (numVal <= limit) return 'red';
    return 'green';
  }

  const lessMatch =
    strRange.match(/<\s*([0-9.]+)/) ||
    strRange.match(/upto\s*([0-9.]+)/i) ||
    strRange.match(/up to\s*([0-9.]+)/i);
  if (lessMatch) {
    const limit = parseFloat(lessMatch[1]);
    if (numVal > limit) return '#e67e22';
    return 'green';
  }

  return null;
}

function chunkArray(array, size) {
  if (!size || size <= 0) return [array];
  const results = [];
  for (let i = 0; i < array.length; i += size) {
    results.push(array.slice(i, i + size));
  }
  return results;
}

function ChartTable({ dates, template, chartValues }) {
  const dateColWidth = `${(56 / Math.max(dates.length, 1)).toFixed(1)}%`;

  return (
    <table className="chart">
      <thead>
        <tr>
          <th style={{ width: '26%' }}>Parameter</th>
          <th style={{ width: '18%' }}>Ref. Range</th>
          {dates.map((d) => (
            <th key={d} style={{ width: dateColWidth }}>{d}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(template).map(([sectionName, fields]) => {
          const activeFields = fields.filter((field) =>
            dates.some((d) => {
              const val = chartValues[field.id]?.[d];
              return (
                val &&
                String(val).trim() !== '' &&
                val !== '--' &&
                val !== '-' &&
                val !== '—'
              );
            })
          );

          if (activeFields.length === 0) return null;

          const isIndividualSection =
            !sectionName ||
            sectionName === 'INDIVIDUAL TESTS' ||
            sectionName === 'OTHER TESTS' ||
            sectionName === 'STANDALONE';

          return (
            <Fragment key={sectionName}>
              {!isIndividualSection && (
                <tr className="section-row">
                  <td colSpan={2 + dates.length}>{sectionName}</td>
                </tr>
              )}
              {activeFields.map((field) => {
                const isNarrativeRange =
                  field.range &&
                  (field.range.length > 30 ||
                    /microcytic|hypochromic|normocytic|anisopoikilocytosis|increased|reduced|smear|granulation|leukocytosis/i.test(
                      field.range
                    ));
                const displayRange = isNarrativeRange ? '' : field.range;

                return (
                  <tr key={field.id}>
                    <td className="field-label">{field.label}</td>
                    <td className="field-range">{displayRange}</td>
                    {dates.map((d) => {
                      const val = chartValues[field.id]?.[d] ?? '';
                      const color = getStatusColor(val, field.range);
                      return (
                        <td
                          key={d}
                          className={`field-value ${val ? 'filled' : 'empty-val'}`}
                          style={color ? { color, fontWeight: 'bold' } : {}}
                        >
                          {val || '—'}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export default function InvestigationChart({ hospital, regNo, chart }) {
  if (!chart?.chartDates?.length) {
    return <div className="empty">Could not build the chart (no Req No / dates detected).</div>;
  }

  const { chartDates, chartValues, patientMeta, template } = chart;
  const printChunks = chunkArray(chartDates, 4); // 4 dates per page for spacious PDF & Print output

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="chart-container">
      {/* Action Toolbar on Screen */}
      <div className="chart-toolbar no-print">
        <div className="toolbar-info">
          <span>Total dates: <b>{chartDates.length}</b></span>
        </div>
        <button type="button" className="btn print-btn" onClick={handlePrint}>
          🖨️ Save as PDF / Print Report
        </button>
      </div>

      {/* 1. SCREEN VIEW: Full Data in 1 Continuous Page */}
      <div className="screen-chart-view chart-card">
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
          <ChartTable dates={chartDates} template={template} chartValues={chartValues} />
        </div>
      </div>

      {/* 2. PRINT / PDF PREVIEW: Formatted cleanly with 5 dates per page */}
      <div className="print-chart-view">
        {printChunks.map((pageDates, pageIdx) => (
          <div className="chart-page-block" key={`print-page-${pageIdx}`}>
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
              <ChartTable dates={pageDates} template={template} chartValues={chartValues} />
            </div>

            <div className="page-footer">
              <span>Page {pageIdx + 1} of {printChunks.length}</span>
              <span>Dates: {pageDates[0]} to {pageDates[pageDates.length - 1]}</span>
              <span>{hospital?.nameEn || 'Investigation Chart'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
