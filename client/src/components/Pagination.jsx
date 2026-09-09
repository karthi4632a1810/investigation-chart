import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
} from './Icons';

export default function Pagination({
  currentPage,
  totalPages,
  totalCount,
  pageSize,
  onPageChange,
  onPageSizeChange,
}) {
  if (totalCount === 0) return null;

  const isAll = pageSize === 'all';
  const numericPageSize = isAll ? totalCount : Number(pageSize);
  const startItem = isAll ? 1 : Math.min((currentPage - 1) * numericPageSize + 1, totalCount);
  const endItem = isAll ? totalCount : Math.min(currentPage * numericPageSize, totalCount);

  // Generate page numbers with ellipses
  function getPageNumbers() {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    if (currentPage <= 4) {
      return [1, 2, 3, 4, 5, '...', totalPages];
    }
    if (currentPage >= totalPages - 3) {
      return [1, '...', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    }
    return [1, '...', currentPage - 1, currentPage, currentPage + 1, '...', totalPages];
  }

  const pageNumbers = isAll ? [] : getPageNumbers();

  return (
    <div className="pagination-bar no-print">
      {/* Left: Range Info */}
      <div className="pagination-info">
        Showing <span className="highlight">{startItem}</span> to{' '}
        <span className="highlight">{endItem}</span> of{' '}
        <span className="highlight">{totalCount}</span> records
      </div>

      {/* Center: Page Controls */}
      {!isAll && totalPages > 1 && (
        <div className="pagination-controls">
          <button
            type="button"
            className="btn-page-nav"
            onClick={() => onPageChange(1)}
            disabled={currentPage === 1}
            title="First page"
            aria-label="First page"
          >
            <ChevronsLeftIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-page-nav"
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            title="Previous page"
            aria-label="Previous page"
          >
            <ChevronLeftIcon size={16} />
            <span className="hide-on-mobile">Prev</span>
          </button>

          <div className="page-numbers-group">
            {pageNumbers.map((num, idx) => {
              if (num === '...') {
                return (
                  <span key={`dots-${idx}`} className="page-ellipsis">
                    …
                  </span>
                );
              }
              return (
                <button
                  key={num}
                  type="button"
                  className={`btn-page-number ${currentPage === num ? 'active' : ''}`}
                  onClick={() => onPageChange(num)}
                  aria-current={currentPage === num ? 'page' : undefined}
                >
                  {num}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="btn-page-nav"
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage === totalPages}
            title="Next page"
            aria-label="Next page"
          >
            <span className="hide-on-mobile">Next</span>
            <ChevronRightIcon size={16} />
          </button>

          <button
            type="button"
            className="btn-page-nav"
            onClick={() => onPageChange(totalPages)}
            disabled={currentPage === totalPages}
            title="Last page"
            aria-label="Last page"
          >
            <ChevronsRightIcon size={16} />
          </button>
        </div>
      )}

      {/* Right: Page Size Selector (50 Default, 100, All) */}
      <div className="pagination-size-selector">
        <span className="size-selector-label">Per page:</span>
        <div className="size-pills-group">
          <button
            type="button"
            className={`size-pill ${pageSize === 50 ? 'active' : ''}`}
            onClick={() => onPageSizeChange(50)}
          >
            50
          </button>
          <button
            type="button"
            className={`size-pill ${pageSize === 100 ? 'active' : ''}`}
            onClick={() => onPageSizeChange(100)}
          >
            100
          </button>
          <button
            type="button"
            className={`size-pill ${pageSize === 'all' ? 'active' : ''}`}
            onClick={() => onPageSizeChange('all')}
          >
            All
          </button>
        </div>
      </div>
    </div>
  );
}
