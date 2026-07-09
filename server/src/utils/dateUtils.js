const DATE_FORMATS = [
  { regex: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/, parse: (m) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) },
  { regex: /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/, parse: (m) => new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) },
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{2}):(\d{2})/, parse: (m) => new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5]) },
  { regex: /^(\d{1,2})-(\d{1,2})-(\d{4}) (\d{2}):(\d{2})/, parse: (m) => new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) },
  { regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})/, parse: (m) => new Date(+m[3], +m[1] - 1, +m[2]) },
  { regex: /^(\d{1,2})-(\d{1,2})-(\d{4})/, parse: (m) => new Date(+m[3], +m[2] - 1, +m[1]) },
];

export function parseSearchDate(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  for (const { regex, parse } of DATE_FORMATS) {
    const match = text.match(regex);
    if (match) {
      const date = parse(match);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

export function normalizeSearchDate(raw) {
  const date = parseSearchDate(raw);
  if (!date) return String(raw || '').trim();

  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatForDatetimeLocal(raw) {
  const date = parseSearchDate(raw);
  if (!date) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function sortChartDates(dates) {
  return [...dates].sort((a, b) => {
    const parse = (d) => {
      const m = d.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!m) return null;
      return new Date(+m[3], +m[2] - 1, +m[1]);
    };
    const ta = parse(a);
    const tb = parse(b);
    if (!ta || !tb) return String(a).localeCompare(String(b));
    return ta - tb;
  });
}
