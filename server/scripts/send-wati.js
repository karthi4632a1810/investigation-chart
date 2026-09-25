#!/usr/bin/env node
/**
 * Standalone WATI test sender — run manually from the `server` directory (so
 * config.js's dotenv.config() picks up ./.env):
 *
 *   node scripts/send-wati.js --number 9384508490 --name "Karthi" --content "test content" --pdfUrl "https://.../file.pdf"
 *
 * Or inside the running container:
 *
 *   docker exec investigation-backend node scripts/send-wati.js --number ... --pdfUrl ...
 */
import { sendInvestigationReportWhatsApp } from '../src/services/watiService.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const hasValue = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--');
      args[key] = hasValue ? argv[++i] : true;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.number || !args.pdfUrl) {
  console.error('Usage: node scripts/send-wati.js --number <phone> [--name <name>] [--content <text>] --pdfUrl <url>');
  process.exit(1);
}

try {
  const result = await sendInvestigationReportWhatsApp({
    toNumber: args.number,
    name: args.name || 'Patient',
    note: args.content || '',
    pdfUrl: args.pdfUrl,
  });
  console.log('Sent:', JSON.stringify(result, null, 2));
} catch (error) {
  console.error('Failed:', error.message);
  process.exit(1);
}
