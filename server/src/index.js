import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { getLabDetail, searchInvestigation } from './services/emrService.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const candidatePaths = [
  path.join(__dirname, '../../client/dist'),
  path.join(__dirname, '../client/dist'),
  path.join(__dirname, '../dist'),
  path.join(__dirname, '../../dist'),
  path.join(__dirname, './dist'),
];

const clientDistPath = candidatePaths.find((p) => fs.existsSync(path.join(p, 'index.html'))) || candidatePaths[0];

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Serve static frontend files (React dist)
  app.use(express.static(clientDistPath));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ ok: false, error: 'Username and password are required' });
    }

    const isValid = username === config.auth.username && password === config.auth.password;

    if (!isValid) {
      return res.status(401).json({ ok: false, error: 'Invalid username or password' });
    }

    res.json({ ok: true, username });
  });

  app.get('/api/config/hospital', (_req, res) => {
    res.json(config.hospital);
  });

  app.post('/api/search', async (req, res) => {
  const { regNo, fromDate, toDate } = req.body || {};

  if (!regNo?.trim() || !fromDate || !toDate) {
    return res.status(400).json({ ok: false, error: 'regNo, fromDate, and toDate are required' });
  }

  try {
    const result = await searchInvestigation(regNo.trim(), fromDate, toDate);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/detail/:orderid', async (req, res) => {
  const orderid = String(req.params.orderid || '').trim();

  if (!orderid || !/^\d+$/.test(orderid)) {
    return res.status(400).json({ ok: false, error: 'Missing or invalid orderid' });
  }

  try {
    const result = await getLabDetail(orderid);
    if (!result.ok) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

  // Fallback for Single Page Application (SPA) routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(clientDistPath, 'index.html'));
  });

  return app;
}

const app = createApp();

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log(`Serving static UI from: ${clientDistPath} (exists: ${fs.existsSync(clientDistPath)})`);
  console.log('Server restarted to load updated .env credentials!');
});
