import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFilePath = process.argv[2] || path.join(__dirname, '..', 'auth.json');

async function loadCredentials() {
  const raw = await readFile(authFilePath, 'utf-8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function main() {
  const credentials = await loadCredentials();

  const client = new MongoClient(config.mongo.uri);
  await client.connect();
  const users = client.db(config.mongo.dbName).collection('users');
  await users.createIndex({ username: 1 }, { unique: true });

  for (const { username, password } of credentials) {
    if (!username || !password) {
      console.warn('Skipping entry missing username/password:', { username });
      continue;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await users.updateOne(
      { username: username.toLowerCase() },
      { $set: { username: username.toLowerCase(), passwordHash, updatedAt: new Date() } },
      { upsert: true },
    );
    console.log(`Imported user: ${username}`);
  }

  await client.close();
}

main().catch((error) => {
  console.error('Import failed:', error.message);
  process.exit(1);
});
