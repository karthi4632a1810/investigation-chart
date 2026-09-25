/**
 * PDF object storage on MinIO (S3-compatible). Reports are stored under
 * `<date>/<IP_NO>.pdf` in a single bucket. Using object storage instead of the
 * container's local disk means a report survives a container restart/redeploy and
 * isn't tied to whichever host the backend happens to be scheduled on.
 *
 * Two clients, deliberately:
 *  - `minioClient` talks to MinIO over the Docker-internal network (MINIO_ENDPOINT,
 *    e.g. "minio") for uploads/existence checks — the backend container's own traffic.
 *  - `presignClient` is configured with MINIO_PUBLIC_ENDPOINT (e.g. "localhost", or
 *    this server's real hostname/IP in a real deployment) because a presigned URL is
 *    handed to the *browser*, which cannot resolve the internal Docker hostname.
 */
import { Client } from 'minio';

const PORT = parseInt(process.env.MINIO_PORT || '4003', 10);
const USE_SSL = process.env.MINIO_USE_SSL === 'true';
const ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin';
const BUCKET = process.env.MINIO_BUCKET || 'investigation-reports';

// A fixed region skips the SDK's automatic bucket-region lookup (a real network
// call to the endpoint). Without it, `presignClient.presignedGetObject` — which
// is deliberately configured with the browser-facing host, e.g. "localhost" —
// tried to connect to that host *from inside this container*, where it's
// unreachable, and failed with ECONNREFUSED before ever getting to sign anything.
// MinIO doesn't enforce real AWS regions, so any fixed value works.
const REGION = process.env.MINIO_REGION || 'us-east-1';

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'localhost',
  port: PORT,
  useSSL: USE_SSL,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
});

// Falls back to MINIO_ENDPOINT when no public endpoint is set, so this still works
// out of the box for host-only (non-Docker) dev.
const presignClient = new Client({
  endPoint: process.env.MINIO_PUBLIC_ENDPOINT || process.env.MINIO_ENDPOINT || 'localhost',
  port: parseInt(process.env.MINIO_PUBLIC_PORT || String(PORT), 10),
  useSSL: process.env.MINIO_PUBLIC_USE_SSL === 'true' || USE_SSL,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
});

let bucketReady = null;

export function reportObjectKey(date, ipNo) {
  return `${date}/${ipNo}.pdf`;
}

/** The EMR's own discharge summary document — separate from the lab investigation chart. */
export function reportSummaryObjectKey(date, ipNo) {
  return `${date}/${ipNo}-summary.pdf`;
}

/** Creates the bucket if it doesn't exist yet. Safe to call repeatedly. */
export async function ensureBucket() {
  if (!bucketReady) {
    bucketReady = (async () => {
      const exists = await minioClient.bucketExists(BUCKET).catch(() => false);
      if (!exists) {
        await minioClient.makeBucket(BUCKET);
        console.log(`[storage] created MinIO bucket "${BUCKET}"`);
      }
    })();
  }
  return bucketReady;
}

export async function uploadPdfFile(objectKey, localFilePath) {
  await ensureBucket();
  await minioClient.fPutObject(BUCKET, objectKey, localFilePath, { 'Content-Type': 'application/pdf' });
}

export async function pdfExists(objectKey) {
  await ensureBucket();
  try {
    await minioClient.statObject(BUCKET, objectKey);
    return true;
  } catch (error) {
    if (error.code === 'NotFound') return false;
    throw error;
  }
}

/** A short-lived, directly-downloadable URL — the browser fetches straight from MinIO. */
export async function getPdfPresignedUrl(objectKey, expirySeconds = 300) {
  await ensureBucket();
  return presignClient.presignedGetObject(BUCKET, objectKey, expirySeconds);
}
