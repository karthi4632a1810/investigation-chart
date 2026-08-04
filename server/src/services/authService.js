import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db.js';
import { config } from '../config.js';

export async function login(username, password) {
  const users = getDb().collection('users');
  const user = await users.findOne({ username: username.toLowerCase() });

  if (!user) {
    return { ok: false, error: 'Invalid username or password' };
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return { ok: false, error: 'Invalid username or password' };
  }

  const token = jwt.sign(
    { sub: user._id.toString(), username: user.username },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn },
  );

  return { ok: true, token, username: user.username };
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}
