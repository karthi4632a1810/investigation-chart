const STORAGE_KEY = 'inv-chart-layout-v1';

export function buildLayoutFromTemplate(template) {
  if (!template || typeof template !== 'object') return [];

  return Object.entries(template).map(([title, fields], index) => ({
    id: `section-${index}-${slug(title)}`,
    title,
    fields: (fields || []).map((f) => ({
      id: f.id,
      label: f.label,
      range: f.range || '',
    })),
  }));
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function loadSavedLayout() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLayout(layout) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* ignore quota */
  }
}

export function clearSavedLayout() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Merge saved order/labels with latest template fields (keeps new tests, drops removed ids).
 */
export function mergeLayoutWithTemplate(saved, template) {
  const fresh = buildLayoutFromTemplate(template);
  if (!saved?.length) return fresh;

  const freshByField = new Map();
  for (const sec of fresh) {
    for (const f of sec.fields) {
      freshByField.set(f.id, { ...f, defaultSectionId: sec.id, defaultTitle: sec.title });
    }
  }

  const used = new Set();
  const merged = [];

  for (const sec of saved) {
    const fields = [];
    for (const f of sec.fields || []) {
      const base = freshByField.get(f.id);
      if (!base) continue;
      used.add(f.id);
      fields.push({
        id: f.id,
        label: f.label || base.label,
        range: base.range,
      });
    }
    merged.push({
      id: sec.id || `section-${merged.length}`,
      title: sec.title || 'Group',
      fields,
    });
  }

  // Append any new template fields not in saved layout
  for (const sec of fresh) {
    const missing = sec.fields.filter((f) => !used.has(f.id));
    if (!missing.length) continue;

    const existing = merged.find((m) => m.title === sec.title || m.id === sec.id);
    if (existing) {
      existing.fields.push(...missing.map((f) => ({ ...f })));
    } else {
      merged.push({
        id: sec.id,
        title: sec.title,
        fields: missing.map((f) => ({ ...f })),
      });
    }
  }

  return merged.filter((s) => s.fields.length > 0 || true);
}

export function sectionsWithValuesFromLayout(layout, chartValues, dates) {
  return (layout || [])
    .map((section) => ({
      sectionName: section.title,
      fields: (section.fields || []).filter((field) => {
        return dates.some((d) => {
          const val = chartValues[field.id]?.[d];
          return val != null && String(val).trim() !== '';
        });
      }),
    }))
    .filter((section) => section.fields.length > 0);
}
