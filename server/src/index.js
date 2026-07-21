import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { getLabDetail, searchInvestigation } from './services/emrService.js';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
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

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log('Server restarted to load updated .env credentials!');
});
