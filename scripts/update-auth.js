import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const authFilePath = path.join(rootDir, 'auth.json');

function loadAuthConfig() {
  if (!fs.existsSync(authFilePath)) {
    throw new Error(`auth.json not found at ${authFilePath}`);
  }

  const raw = fs.readFileSync(authFilePath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed.username || !parsed.password) {
    throw new Error('auth.json must include username and password');
  }

  return parsed;
}

async function main() {
  const { username, password } = loadAuthConfig();
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const dbName = process.env.MONGO_DB || 'investigation-chart';
  const collectionName = process.env.MONGO_COLLECTION || 'auth';

  const client = new MongoClient(mongoUri);

  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    await collection.deleteMany({});
    await collection.insertOne({
      username,
      password,
      updatedAt: new Date(),
    });

    console.log(`Updated auth credentials in ${dbName}.${collectionName}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error('Failed to update auth credentials:', error.message);
  process.exit(1);
});
