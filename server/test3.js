import { normalizeTestKey } from './src/templates/chartTemplate.js';

const key = normalizeTestKey('URINE COLOUR');
let searchKey = key;
if (searchKey.startsWith('URINE')) {
  searchKey = searchKey.replace(/^URINE\s*/, '').trim();
}
console.log('key:', key);
console.log('searchKey:', searchKey);
