/**
 * Shared MongoDB connection. Holds report metadata (see dischargeReportService.js) —
 * the PDFs themselves live in MinIO (storageService.js).
 */
import { MongoClient } from 'mongodb';

// Docker-internal default is "mongo:3003" (see docker-compose.yml, which runs mongod
// on 3003 rather than the default 27017 so the internal and host-published ports
// match). This localhost fallback is only for running the server outside Docker.
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:3003';
const MONGO_DB = process.env.MONGO_DB || 'investigation-chart';

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    clientPromise = client.connect().catch((error) => {
      clientPromise = null;
      throw error;
    });
  }
  return clientPromise;
}

export async function getMongoCollection(name) {
  const client = await getClient();
  return client.db(MONGO_DB).collection(name);
}
