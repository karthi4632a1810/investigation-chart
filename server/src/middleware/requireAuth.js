import { verifyToken } from '../services/authService.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Authentication required' });
  }

  try {
    req.user = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }
}
