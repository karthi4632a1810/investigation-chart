import { fetchSearchResults } from './src/services/emrService.js';

async function checkCxm() {
  const res = await fetchSearchResults('4314566', '2026-06-01', '2026-07-21');
  if (res.ok) {
    const cxmRows = res.data.filter(r => JSON.stringify(r).includes('CXM') || JSON.stringify(r).includes('CROSS'));
    console.log('CXM search rows:', cxmRows);
  }
}

checkCxm();
