import { MongoClient } from 'mongodb';
import { config } from './config.js';

let client;
let db;

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  db = client.db(config.mongo.dbName);
  return db;
}

export function getDb() {
  if (!db) throw new Error('Database not connected yet');
  return db;
}
