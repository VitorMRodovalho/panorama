/**
 * ObjectStorage config — read once at bootstrap (ADR-0012 §3).
 *
 * Fail-fast on missing required values; rejects SSRF-risky endpoints
 * in production. DNS resolution of the endpoint host is deferred to
 * `ObjectStorageService.onModuleInit` so this module is side-effect
 * free for testing.
 */
import { URL } from 'node:url';
import { z } from 'zod';

export interface ObjectStorageConfig {
  /** e.g. `http://localhost:9000` (MinIO) or `undefined` (real AWS). */
  endpoint?: string;
  region: string;
  bucketPhotos: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
  signedUrlTtlSeconds: number;
  /**
   * Dev-only escape: permit `endpoint` to resolve to a private IP
   * (loopback / RFC 1918). Production leaves this false; SSRF guard
   * rejects resolved addresses that hit IMDS / metadata endpoints.
   */
  allowPrivateEndpoint: boolean;
  /** `development` | `production` | `test` from `NODE_ENV`. */
  nodeEnv: string;
}

const ConfigSchema = z.object({
  NODE_ENV: z.string().default('development'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET_PHOTOS: z.string().min(1, 'S3_BUCKET_PHOTOS required'),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY required'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY required'),
  S3_FORCE_PATH_STYLE: z.string().default('false'),
  S3_SIGNED_URL_TTL_SECONDS: z.string().default('300'),
  S3_ALLOW_PRIVATE_ENDPOINT: z.string().default('false'),
});

const truthy = (s: string | undefined) =>
  s !== undefined && !['false', '0', 'no', ''].includes(s.toLowerCase());

/**
 * Parse + validate env. Throws a readable Error if required vars are
 * missing or the endpoint URL is malformed. Does NOT do DNS
 * resolution — that happens in the service's bootstrap phase.
 */
export function loadObjectStorageConfig(env: NodeJS.ProcessEnv): ObjectStorageConfig {
  const parsed = ConfigSchema.parse(env);

  const endpoint = parsed.S3_ENDPOINT;
  if (endpoint) {
    // Pre-flight URL check — `z.string().url()` already validates,
    // but we also enforce the production scheme rule here so the
    // error message is domain-specific.
    const url = new URL(endpoint);
    const isProduction = parsed.NODE_ENV === 'production';
    if (isProduction && url.protocol !== 'https:') {
      throw new Error(
        `S3_ENDPOINT must use https:// in production (got ${url.protocol}//${url.host})`,
      );
    }
  }

  const base: ObjectStorageConfig = {
    region: parsed.S3_REGION,
    bucketPhotos: parsed.S3_BUCKET_PHOTOS,
    accessKey: parsed.S3_ACCESS_KEY,
    secretKey: parsed.S3_SECRET_KEY,
    forcePathStyle: truthy(parsed.S3_FORCE_PATH_STYLE),
    signedUrlTtlSeconds: Number.parseInt(parsed.S3_SIGNED_URL_TTL_SECONDS, 10),
    allowPrivateEndpoint: truthy(parsed.S3_ALLOW_PRIVATE_ENDPOINT),
    nodeEnv: parsed.NODE_ENV,
  };
  return endpoint ? { ...base, endpoint } : base;
}

/**
 * Private/metadata IP ranges + FQDN suffixes the SSRF guard rejects.
 * Exported for unit tests.
 */
export const PRIVATE_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
];

export const PRIVATE_FQDN_SUFFIXES = [
  'metadata.google.internal',
  'metadata.azure.com',
  '.internal',
  '.local',
  '.localdomain',
] as const;

/** IPv4 literal → 32-bit unsigned integer. */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
    return Number.NaN;
  }
  const [a, b, c, d] = parts as [number, number, number, number];
  return (((a << 24) | (b << 16) | (c << 8) | d) >>> 0);
}

export function isPrivateIPv4(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);
  if (!Number.isFinite(ipInt)) return false;
  for (const [cidrIp, cidrBits] of PRIVATE_IPV4_CIDRS) {
    const mask = cidrBits === 0 ? 0 : (-1 << (32 - cidrBits)) >>> 0;
    const cidrInt = ipv4ToInt(cidrIp);
    if ((ipInt & mask) === (cidrInt & mask)) return true;
  }
  return false;
}

export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  // fc00::/7 unique-local range — first hextet starts with fc or fd
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true;
  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;
  return false;
}

export function isForbiddenHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return PRIVATE_FQDN_SUFFIXES.some(
    (suffix) => lower === suffix || lower.endsWith(suffix),
  );
}
