import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFilePath = process.argv[2] || path.join(__dirname, '..', 'auth.txt');

async function loadCredentials() {
  const raw = await readFile(authFilePath, 'utf-8');

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const idx = line.indexOf(':');
      if (idx === -1) return null;
      return {
        username: line.slice(0, idx).trim(),
        password: line.slice(idx + 1).trim(),
      };
    })
    .filter((entry) => entry?.username && entry?.password);
}

async function main() {
  const credentials = await loadCredentials();

  if (!credentials.length) {
    throw new Error(`No valid username:password entries found in ${authFilePath}`);
  }

  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  const users = client.db(config.mongo.dbName).collection('users');
  await users.createIndex({ username: 1 }, { unique: true });

  const keepUsernames = credentials.map(({ username }) => username.toLowerCase());

  for (const { username, password } of credentials) {
    const passwordHash = await bcrypt.hash(password, 10);
    await users.updateOne(
      { username: username.toLowerCase() },
      { $set: { username: username.toLowerCase(), passwordHash, updatedAt: new Date() } },
      { upsert: true },
    );
    console.log(`Imported user: ${username}`);
  }

  const { deletedCount } = await users.deleteMany({ username: { $nin: keepUsernames } });
  if (deletedCount) {
    console.log(`Removed ${deletedCount} user(s) not present in ${authFilePath}`);
  }

  await client.close();
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exit(1);
});
