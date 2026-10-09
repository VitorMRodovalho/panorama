import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Shared test helper: is the S3-compatible object storage ready?
 *
 * A signed HeadBucket proves three things in one call: the endpoint
 * answers, the dev credentials are accepted, and the photos bucket
 * exists. It is vendor-neutral on purpose: the previous probe hit
 * MinIO's own `/minio/health/live`, which no other server implements
 * (#293). A plain health endpoint is not enough either: SeaweedFS
 * answers `/healthz` before its startup bucket has been created.
 *
 * Reads the same S3_* env the app does (defaults in `_setup.ts`).
 * Returns null when ready, or a one-line reason when not.
 */
export async function objectStorageProblem(): Promise<string | null> {
  const endpoint = process.env['S3_ENDPOINT'];
  const bucket = process.env['S3_BUCKET_PHOTOS'];
  const client = new S3Client({
    region: process.env['S3_REGION'] ?? 'us-east-1',
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: process.env['S3_FORCE_PATH_STYLE'] === 'true',
    credentials: {
      accessKeyId: process.env['S3_ACCESS_KEY'] ?? '',
      secretAccessKey: process.env['S3_SECRET_KEY'] ?? '',
    },
    maxAttempts: 1,
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return null;
  } catch (err) {
    const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.$metadata?.httpStatusCode;
    const detail = status ? ` (HTTP ${status})` : e.code ? ` (${e.code})` : '';
    return `HeadBucket ${bucket} at ${endpoint} failed: ${e.name ?? 'error'}${detail}`;
  } finally {
    client.destroy();
  }
}

export async function assertObjectStorageReady(): Promise<void> {
  const problem = await objectStorageProblem();
  if (problem) {
    throw new Error(
      `Object storage not ready — ${problem}. Start the dev stack: ` +
        'docker compose -f infra/docker/compose.dev.yml up -d seaweedfs',
    );
  }
}
