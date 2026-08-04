import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { connectDb } from './db.js';
import { getLabDetail, searchInvestigation } from './services/emrService.js';
import { login } from './services/authService.js';
import { requireAuth } from './middleware/requireAuth.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config/hospital', (_req, res) => {
  res.json(config.hospital);
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username?.trim() || !password) {
    return res.status(400).json({ ok: false, error: 'username and password are required' });
  }

  try {
    const result = await login(username.trim(), password);
    if (!result.ok) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/search', requireAuth, async (req, res) => {
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

app.get('/api/detail/:orderid', requireAuth, async (req, res) => {
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

connectDb()
  .then(() => {
    app.listen(config.port, () => {
      console.log(`Server running on http://localhost:${config.port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to connect to MongoDB:', error.message);
    process.exit(1);
  });
