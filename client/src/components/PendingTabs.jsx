import { useState } from 'react';

export default function PendingTabs({ groups = {}, onViewDetail = () => {} }) {
  const keys = Object.keys(groups).filter((k) => groups[k] && groups[k].length > 0);
  const [active, setActive] = useState(keys[0] || null);
  if (!keys.length) return null;

  return (
    <div className="pending-tabs">
      <div className="pending-tabs-head">
        {keys.map((k) => {
          const extra = String(k).toLowerCase().includes('cancel') ? 'cancel' : '';
          return (
            <button
              key={k}
              type="button"
              className={`tab-btn ${extra} ${active === k ? 'active' : ''}`}
              onClick={() => setActive(k)}
            >
              {k} <span className="count">{groups[k].length}</span>
            </button>
          );
        })}
      </div>

      <div className="pending-tabs-body">
        {active && (
          <div className="pending-list">
            {groups[active].map((p, i) => {
              const m = String(p).match(/Req\s*No\s*(\d+)/i);
              const id = m ? m[1] : null;
              return (
                <div
                  key={`${active}-${i}-${p}`}
                  className="pending-item"
                  onClick={() => id && onViewDetail(id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && id) onViewDetail(id); }}
                  role="button"
                  tabIndex={0}
                >
                  {p}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
