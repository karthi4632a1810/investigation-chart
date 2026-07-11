import { useState } from 'react';

export default function PendingDropdown({ pending = [], onViewDetail = () => {} }) {
  const [open, setOpen] = useState(false);
  if (!pending || pending.length === 0) return null;

  return (
    <div className="pending-dropdown">
      <button
        type="button"
        className="pending-btn"
        onClick={() => setOpen((s) => !s)}
        aria-expanded={open}
      >
        🟠 Pending {pending.length}
      </button>

      {open && (
        <div className="pending-list" role="menu">
          {pending.map((p, i) => {
            const m = String(p).match(/Req\s*No\s*(\d+)/i);
            const id = m ? m[1] : null;
            return (
              <div
                key={`${i}-${p}`}
                className="pending-item"
                role="menuitem"
                tabIndex={0}
                onClick={() => id && onViewDetail(id)}
                onKeyDown={(e) => { if (e.key === 'Enter' && id) onViewDetail(id); }}
              >
                {p}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
