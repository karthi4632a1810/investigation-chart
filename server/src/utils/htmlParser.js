import * as cheerio from 'cheerio';

function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function extractResultTable(html) {
  if (!html) return null;

  const $ = cheerio.load(html);
  const table = $('#OrdID');
  if (!table.length) return null;

  return $.html(table);
}

export function parseResultTableToArray(tableHtml) {
  if (!tableHtml) return [];

  const $ = cheerio.load(tableHtml);
  const out = [];

  $('#OrdID tr').each((_, tr) => {
    const $tr = $(tr);
    if (($tr.attr('class') || '').includes('trtest')) return;

    const cells = $tr.find('td');
    if (cells.length < 3) {
      if (cells.length >= 1) {
        const label = collapseWhitespace(cells.eq(0).text());
        if (label) out.push({ section: label });
      }
      return;
    }

    out.push({
      test: collapseWhitespace(cells.eq(0).text()),
      value: collapseWhitespace(cells.eq(1).text()),
      range: collapseWhitespace(cells.eq(2).text()),
    });
  });

  return out;
}

export function extractOrderIdFromCell(rawValue) {
  const raw = String(rawValue || '');
  const match = raw.match(/Orderid=(\d+)/i);
  const orderId = match ? match[1] : null;

  const stripped = raw.replace(/<[^>]*>/g, '').trim();
  const display = stripped || orderId || '';

  return { orderid: orderId, display };
}

export function normCol(c) {
  return String(c).toLowerCase().replace(/[^a-z0-9]/g, '');
}
