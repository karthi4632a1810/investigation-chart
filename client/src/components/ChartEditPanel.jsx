import { useEffect, useRef } from 'react';
import Sortable from 'sortablejs';

export default function ChartEditPanel({ open, layout, onClose, onChange, onReset }) {
  const bodyRef = useRef(null);
  const layoutRef = useRef(layout);
  const onChangeRef = useRef(onChange);
  layoutRef.current = layout;
  onChangeRef.current = onChange;

  const structureKey = layout
    .map((s) => `${s.id}:${s.fields.map((f) => f.id).join(',')}`)
    .join('|');

  useEffect(() => {
    if (!open || !bodyRef.current) return undefined;

    const body = bodyRef.current;
    const sortables = [];

    function emit(next) {
      onChangeRef.current(next);
    }

    function syncFieldsFromDom() {
      const fieldMap = new Map();
      for (const sec of layoutRef.current) {
        for (const f of sec.fields) fieldMap.set(f.id, f);
      }

      const next = layoutRef.current.map((sec) => {
        const list = body.querySelector(
          `.chart-edit-fields[data-section-id="${CSS.escape(sec.id)}"]`,
        );
        if (!list) return { ...sec, fields: [...sec.fields] };

        const fields = [...list.querySelectorAll(':scope > .chart-edit-field')]
          .map((el) => fieldMap.get(el.dataset.fieldId))
          .filter(Boolean);

        return { ...sec, fields };
      });

      emit(next);
    }

    sortables.push(
      Sortable.create(body, {
        animation: 220,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        handle: '.group-handle',
        draggable: '.chart-edit-group',
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        forceFallback: true,
        fallbackClass: 'sortable-fallback',
        fallbackTolerance: 3,
        fallbackOnBody: true,
        swapThreshold: 0.65,
        delay: 0,
        onEnd() {
          const ids = [...body.querySelectorAll(':scope > .chart-edit-group')].map(
            (el) => el.dataset.sectionId,
          );
          const map = Object.fromEntries(layoutRef.current.map((s) => [s.id, s]));
          const next = ids.map((id) => map[id]).filter(Boolean);
          if (next.length) emit(next);
        },
      }),
    );

    body.querySelectorAll('.chart-edit-fields').forEach((listEl) => {
      sortables.push(
        Sortable.create(listEl, {
          group: 'chart-fields',
          animation: 220,
          easing: 'cubic-bezier(0.2, 0, 0, 1)',
          handle: '.field-handle',
          draggable: '.chart-edit-field',
          ghostClass: 'sortable-ghost',
          chosenClass: 'sortable-chosen',
          dragClass: 'sortable-drag',
          forceFallback: true,
          fallbackClass: 'sortable-fallback',
          fallbackTolerance: 3,
          fallbackOnBody: true,
          swapThreshold: 0.65,
          emptyInsertThreshold: 28,
          onAdd: syncFieldsFromDom,
          onUpdate: syncFieldsFromDom,
        }),
      );
    });

    return () => {
      sortables.forEach((s) => s.destroy());
    };
  }, [open, structureKey]);

  if (!open) return null;

  function setGroupTitle(sectionId, title) {
    onChange(layout.map((s) => (s.id === sectionId ? { ...s, title } : s)));
  }

  function setFieldLabel(sectionId, fieldId, label) {
    onChange(
      layout.map((s) => {
        if (s.id !== sectionId) return s;
        return {
          ...s,
          fields: s.fields.map((f) => (f.id === fieldId ? { ...f, label } : f)),
        };
      }),
    );
  }

  return (
    <>
      <div className="chart-edit-backdrop" onClick={onClose} />
      <aside className="chart-edit-panel" aria-label="Edit chart layout">
        <div className="chart-edit-panel-head">
          <div>
            <strong>Edit chart</strong>
            <div className="chart-edit-hint">Rename groups &amp; tests · drag to reorder</div>
          </div>
          <div className="chart-edit-panel-actions">
            <button
              type="button"
              className="chart-icon-btn"
              title="Reset to default"
              onClick={onReset}
            >
              ↺
            </button>
            <button type="button" className="chart-icon-btn" title="Close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>

        <div className="chart-edit-panel-body" ref={bodyRef}>
          {layout.map((section) => (
            <div key={section.id} className="chart-edit-group" data-section-id={section.id}>
              <div className="chart-edit-group-head">
                <span className="drag-handle group-handle" title="Drag group">
                  ⋮⋮
                </span>
                <input
                  className="chart-edit-group-input"
                  value={section.title}
                  onChange={(e) => setGroupTitle(section.id, e.target.value)}
                />
              </div>

              <ul className="chart-edit-fields" data-section-id={section.id}>
                {section.fields.map((field) => (
                  <li key={field.id} className="chart-edit-field" data-field-id={field.id}>
                    <span className="drag-handle field-handle" title="Drag test">
                      ⋮⋮
                    </span>
                    <input
                      className="chart-edit-field-input"
                      value={field.label}
                      onChange={(e) => setFieldLabel(section.id, field.id, e.target.value)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>
    </>
  );
}
