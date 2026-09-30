import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/*
 * Small SVG charts for the WhatsApp monitor. Specs follow the data-viz method:
 * thin marks (bars <= 24px, 4px rounded data-end, square at the baseline),
 * hairline solid gridlines, 2px surface gap between stacked segments, one
 * tooltip listing every series at the hovered bucket, a legend for >= 2
 * series, and a table view for every chart. Colours come from CSS variables
 * in App.css (ordinal blue ramp for sent → delivered → read; reserved status
 * colours for pending / failed).
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Animates a number from its previous value to `target`. */
export function useCountUp(target, duration = 700) {
  const [value, setValue] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const to = Number(target) || 0;
    if (prefersReducedMotion()) {
      setValue(to);
      from.current = to;
      return undefined;
    }
    const start = performance.now();
    const begin = from.current;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      setValue(begin + (to - begin) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

/** True after the first paint — lets bars grow from 0 on mount. */
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return mounted;
}

function useWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function formatCompact(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n >= 10000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K`;
  return Math.round(n).toLocaleString('en-IN');
}

export function Sparkline({ values, color = 'var(--viz-accent)', width = 96, height = 28 }) {
  if (!values?.length || values.every((v) => !v)) return <svg className="viz-spark" width={width} height={height} aria-hidden="true" />;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)]);
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = points[points.length - 1];
  return (
    <svg className="viz-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="var(--viz-muted-line)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength="1" className="viz-spark-line" />
      <circle cx={lx} cy={ly} r="3.5" fill={color} stroke="var(--viz-surface)" strokeWidth="2" />
    </svg>
  );
}

/**
 * Stat tile: label · value (count-up) · sub line · optional sparkline.
 * `status` adds the reserved status icon so colour never carries meaning alone.
 */
/**
 * Change vs the previous period. `upIsGood` sets the colour: more read is
 * good, more failed is bad. Arrow + sign carry the direction, not colour alone.
 */
export function Delta({ current, previous, upIsGood = true, label = 'vs previous period' }) {
  if (previous === null || previous === undefined || current === null || current === undefined) return null;
  if (previous === 0 && current === 0) return <span className="viz-delta is-flat" title={label}>— same</span>;
  if (previous === 0) return <span className={`viz-delta ${upIsGood ? 'is-good' : 'is-bad'}`} title={label}>▲ new</span>;
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return <span className="viz-delta is-flat" title={label}>— same</span>;
  const up = change > 0;
  const good = up === upIsGood;
  return (
    <span className={`viz-delta ${good ? 'is-good' : 'is-bad'}`} title={`${label}: ${previous}`}>
      {up ? '▲' : '▼'} {Math.abs(Math.round(change * 100))}%
    </span>
  );
}

export function StatTile({ label, value, format = formatCompact, sub, trend, icon, tone, delta }) {
  const animated = useCountUp(value ?? 0);
  return (
    <div className={`viz-tile ${tone ? `is-${tone}` : ''}`}>
      <div className="viz-tile-top">
        <span className="viz-tile-label">
          {icon}
          {label}
        </span>
        {trend && <Sparkline values={trend} />}
      </div>
      <div className="viz-tile-value-row">
        <div className="viz-tile-value">{value === null || value === undefined ? '—' : format(animated)}</div>
        {delta}
      </div>
      {sub && <div className="viz-tile-sub">{sub}</div>}
    </div>
  );
}

/** Card with title, subtitle, a legend slot and a chart/table toggle. */
export function ChartCard({ title, subtitle, legend, table, children, className = '' }) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`viz-card ${className}`}>
      <header className="viz-card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {table && (
          <div className="viz-toggle" role="group" aria-label={`${title} view`}>
            <button type="button" className={!asTable ? 'is-on' : ''} onClick={() => setAsTable(false)}>
              Chart
            </button>
            <button type="button" className={asTable ? 'is-on' : ''} onClick={() => setAsTable(true)}>
              Table
            </button>
          </div>
        )}
      </header>
      {legend && !asTable && <div className="viz-legend">{legend}</div>}
      {asTable ? <div className="viz-table-wrap">{table}</div> : children}
    </section>
  );
}

export function LegendItem({ color, label, shape = 'rect' }) {
  return (
    <span className="viz-legend-item">
      <span className={`viz-key is-${shape}`} style={{ background: color }} />
      {label}
    </span>
  );
}

/**
 * Stacked columns over time. `data`: [{ bucket, [series.key]: n }].
 * Series stack bottom → top in the order given.
 */
export function StackedColumns({ data, series, formatBucket = (b) => b, height = 220 }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  const mounted = useMounted();
  const [hover, setHover] = useState(null);

  const pad = { top: 10, right: 8, bottom: 26, left: 34 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const totals = data.map((d) => series.reduce((s, x) => s + (d[x.key] || 0), 0));
  const rawMax = Math.max(...totals, 1);
  const tickStep = rawMax <= 4 ? 1 : rawMax <= 10 ? 2 : Math.ceil(rawMax / 4 / 5) * 5;
  const max = Math.ceil(rawMax / tickStep) * tickStep;
  const ticks = [];
  for (let t = 0; t <= max; t += tickStep) ticks.push(t);
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 44))));
  const GAP = 2;

  return (
    <div className="viz-plot" ref={wrapRef} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Messages over time by status">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = pad.left + band * i + band / 2;
            let acc = 0;
            const segs = series
              .map((s) => ({ ...s, v: d[s.key] || 0 }))
              .filter((s) => s.v > 0);
            return (
              <g key={d.bucket}>
                {hover === i && <rect x={cx - band / 2} y={pad.top} width={band} height={plotH} className="viz-hover-band" />}
                {segs.map((s, j) => {
                  const y0 = y(acc);
                  acc += s.v;
                  const y1 = y(acc);
                  const top = j === segs.length - 1;
                  const h = Math.max(0, y0 - y1 - (j > 0 ? GAP : 0));
                  const yTop = y1;
                  const r = top ? Math.min(4, h / 2, barW / 2) : 0;
                  const x = cx - barW / 2;
                  const path = `M${x},${yTop + h} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + barW - r} Q${x + barW},${yTop} ${x + barW},${yTop + r} V${yTop + h} Z`;
                  return (
                    <path
                      key={s.key}
                      d={path}
                      fill={s.color}
                      className="viz-bar"
                      style={{ transform: mounted ? 'scaleY(1)' : 'scaleY(0)', transformOrigin: `${cx}px ${pad.top + plotH}px`, transitionDelay: `${Math.min(i * 18, 400)}ms` }}
                    />
                  );
                })}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">
                    {formatBucket(d.bucket, true)}
                  </text>
                )}
                <rect
                  x={cx - band / 2}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${formatBucket(d.bucket)}: ${totals[i]} messages`}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div
          className="viz-tooltip"
          style={{
            left: Math.min(Math.max(pad.left + band * hover + band / 2, 90), width - 90),
            top: 4,
          }}
        >
          <div className="viz-tooltip-title">{formatBucket(data[hover].bucket)}</div>
          <div className="viz-tooltip-total">
            <b>{totals[hover]}</b> messages
          </div>
          {[...series].reverse().map((s) => (
            <div key={s.key} className="viz-tooltip-row">
              <span className="viz-line-key" style={{ background: s.color }} />
              <b>{data[hover][s.key] || 0}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Horizontal bars with the value at the bar end. `items`: [{ label, value, color?, note? }]. */
export function HBars({ items, color = 'var(--viz-accent)', max: maxOverride }) {
  const mounted = useMounted();
  const max = maxOverride || Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="viz-hbars">
      {items.map((item, i) => (
        <div className="viz-hbar" key={item.label} title={`${item.label}: ${item.value}${item.note ? ` (${item.note})` : ''}`}>
          <div className="viz-hbar-label">{item.label}</div>
          <div className="viz-hbar-track">
            <div
              className="viz-hbar-fill"
              style={{
                width: mounted ? `${(item.value / max) * 100}%` : '0%',
                background: item.color || color,
                transitionDelay: `${i * 70}ms`,
              }}
            />
          </div>
          <div className="viz-hbar-value">
            <b>{formatCompact(item.value)}</b>
            {item.note && <span>{item.note}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Percent lines over time (0–100%). `series`: [{ key, label, color }].
 * Crosshair snaps to the nearest bucket; one tooltip lists every series.
 */
export function RateLines({ data, series, formatBucket = (b) => b, height = 200 }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  const [hover, setHover] = useState(null);
  const pad = { top: 12, right: 14, bottom: 26, left: 40 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const x = (i) => pad.left + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const y = (v) => pad.top + plotH - v * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 48))));

  function onMove(e) {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.left;
    const i = data.length > 1 ? Math.round((px / plotW) * (data.length - 1)) : 0;
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  return (
    <div className="viz-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Delivery and read rate over time">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'viz-axis' : 'viz-grid'} />
              <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="viz-tick">
                {Math.round(t * 100)}%
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 ? (
              <text key={d.bucket} x={x(i)} y={height - 8} textAnchor="middle" className="viz-tick">
                {formatBucket(d.bucket, true)}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} className="viz-crosshair" />}
          {series.map((s) => {
            const pts = data.map((d, i) => (d[s.key] === null || d[s.key] === undefined ? null : [x(i), y(d[s.key])]));
            // Break the line where a day has no data rather than drawing through it.
            let dPath = '';
            let pen = false;
            for (const p of pts) {
              if (!p) {
                pen = false;
                continue;
              }
              dPath += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)} `;
              pen = true;
            }
            const last = [...pts].reverse().find(Boolean);
            return (
              <g key={s.key}>
                <path d={dPath} fill="none" stroke={s.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" pathLength="1" className="viz-line" />
                {/* A marker per day while days are few enough to tell apart (and so isolated days still show). */}
                {pts.length <= 45
                  ? pts.map((p, i) => p && <circle key={i} cx={p[0]} cy={p[1]} r="4" fill={s.color} stroke="var(--viz-surface)" strokeWidth="2" />)
                  : last && <circle cx={last[0]} cy={last[1]} r="4" fill={s.color} stroke="var(--viz-surface)" strokeWidth="2" />}
                {hover !== null && pts[hover] && <circle cx={pts[hover][0]} cy={pts[hover][1]} r="5" fill={s.color} stroke="var(--viz-surface)" strokeWidth="2" />}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="viz-tooltip" style={{ left: Math.min(Math.max(x(hover), 90), width - 90), top: 4 }}>
          <div className="viz-tooltip-title">{formatBucket(data[hover].bucket)}</div>
          <div className="viz-tooltip-total">
            <b>{data[hover].total}</b> messages
          </div>
          {series.map((s) => (
            <div key={s.key} className="viz-tooltip-row">
              <span className="viz-line-key" style={{ background: s.color }} />
              <b>{data[hover][s.key] === null || data[hover][s.key] === undefined ? '—' : `${Math.round(data[hover][s.key] * 100)}%`}</b>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One series of columns (hours of the day, time buckets). Each column is its own hover target. */
export function Columns({ data, color = 'var(--viz-accent)', height = 180, valueLabel = 'messages', formatLabel = (l) => l, labelEvery = 1, highlightMax = false }) {
  const wrapRef = useRef(null);
  const width = useWidth(wrapRef);
  const mounted = useMounted();
  const [hover, setHover] = useState(null);
  const pad = { top: 16, right: 6, bottom: 24, left: 30 };
  const plotW = Math.max(0, width - pad.left - pad.right);
  const plotH = height - pad.top - pad.bottom;
  const max = Math.max(...data.map((d) => d.value), 1);
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.7));
  const y = (v) => pad.top + plotH - (v / max) * plotH;
  const maxIndex = data.reduce((best, d, i) => (d.value > data[best].value ? i : best), 0);

  return (
    <div className="viz-plot" ref={wrapRef} onMouseLeave={() => setHover(null)} style={{ minHeight: height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="viz-axis" />
          <text x={pad.left - 6} y={y(max)} dy="0.32em" textAnchor="end" className="viz-tick">
            {max}
          </text>
          {data.map((d, i) => {
            const cx = pad.left + band * i + band / 2;
            const h = Math.max(0, y(0) - y(d.value));
            const r = Math.min(4, h / 2, barW / 2);
            const x0 = cx - barW / 2;
            const top = y(d.value);
            const path = h > 0 ? `M${x0},${y(0)} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + barW - r} Q${x0 + barW},${top} ${x0 + barW},${top + r} V${y(0)} Z` : '';
            return (
              <g key={d.label}>
                {hover === i && <rect x={cx - band / 2} y={pad.top} width={band} height={plotH} className="viz-hover-band" />}
                {path && (
                  <path
                    d={path}
                    fill={color}
                    opacity={highlightMax && i !== maxIndex ? 0.55 : 1}
                    className="viz-bar"
                    style={{ transform: mounted ? 'scaleY(1)' : 'scaleY(0)', transformOrigin: `${cx}px ${y(0)}px`, transitionDelay: `${Math.min(i * 20, 400)}ms` }}
                  />
                )}
                {highlightMax && i === maxIndex && d.value > 0 && (
                  <text x={cx} y={top - 5} textAnchor="middle" className="viz-peak">
                    {d.value}
                  </text>
                )}
                {i % labelEvery === 0 && (
                  <text x={cx} y={height - 8} textAnchor="middle" className="viz-tick">
                    {formatLabel(d.label, true)}
                  </text>
                )}
                <rect
                  x={cx - band / 2}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  aria-label={`${formatLabel(d.label)}: ${d.value} ${valueLabel}`}
                />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <div className="viz-tooltip" style={{ left: Math.min(Math.max(pad.left + band * hover + band / 2, 80), width - 80), top: 0 }}>
          <div className="viz-tooltip-title">{formatLabel(data[hover].label)}</div>
          <div className="viz-tooltip-total">
            <b>{data[hover].value}</b> {valueLabel}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Horizontal stacked bars, one per category. `rows`: [{ label, [series.key]: n }].
 * 2px surface gap between segments; each segment's value is in its hover title
 * and in the card's table view.
 */
export function StackedHBars({ rows, series }) {
  const mounted = useMounted();
  const totals = rows.map((r) => series.reduce((sum, s) => sum + (r[s.key] || 0), 0));
  const max = Math.max(...totals, 1);
  return (
    <div className="viz-hbars">
      {rows.map((r, i) => (
        <div className="viz-hbar" key={r.label}>
          <div className="viz-hbar-label">{r.label}</div>
          <div className="viz-hbar-track">
            <div className="viz-stack" style={{ width: mounted ? `${(totals[i] / max) * 100}%` : '0%', transitionDelay: `${i * 70}ms` }}>
              {series
                .filter((s) => r[s.key] > 0)
                .map((s) => (
                  <span key={s.key} className="viz-stack-seg" style={{ flexGrow: r[s.key], background: s.color }} title={`${r.label} · ${s.label}: ${r[s.key]}`} />
                ))}
            </div>
          </div>
          <div className="viz-hbar-value">
            <b>{totals[i]}</b>
          </div>
        </div>
      ))}
    </div>
  );
}
