export default function SearchForm({
  regNo,
  fromDate,
  toDate,
  loading,
  showPrint,
  onRegNoChange,
  onFromDateChange,
  onToDateChange,
  onSubmit,
}) {
  return (
    <form className="searchbar" onSubmit={onSubmit}>
      <div className="field">
        <label>UHID</label>
        <input
          type="text"
          value={regNo}
          onChange={(e) => onRegNoChange(e.target.value)}
          placeholder="e.g. 4975109"
          required
        />
      </div>
      <div className="field date-range">
        <label>Date of Admission</label>
        <input
          type="datetime-local"
          value={fromDate}
          onChange={(e) => onFromDateChange(e.target.value)}
          required
        />
      </div>
      <div className="field date-range">
        <label>Date of Discharge</label>
        <input
          type="datetime-local"
          value={toDate}
          onChange={(e) => onToDateChange(e.target.value)}
          required
        />
      </div>
      <div className="search-actions">
        <button type="submit" className="btn" disabled={loading}>
          {loading ? 'Searching…' : 'Search'}
        </button>
        {showPrint && (
          <button type="button" className="btn secondary" onClick={() => window.print()}>
            🖨️ Print Chart
          </button>
        )}
      </div>
    </form>
  );
}
