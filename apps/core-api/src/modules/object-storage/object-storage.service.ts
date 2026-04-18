import {
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { URL } from 'node:url';
import dns from 'node:dns/promises';
import { AuditService } from '../audit/audit.service.js';
import {
  type ObjectStorageConfig,
  isForbiddenHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  loadObjectStorageConfig,
} from './object-storage.config.js';
import { INSPECTION_PHOTO_KEY_REGEX } from './object-storage.keys.js';

/**
 * ObjectStorageService (ADR-0012 §3).
 *
 * S3-compatible client (MinIO dev, AWS/R2/Wasabi prod) with:
 *
 *   * Bootstrap SSRF validation — `S3_ENDPOINT` is DNS-resolved and
 *     every A/AAAA answer is checked against private / metadata
 *     ranges. Refused endpoints fail the app's boot.
 *   * `put / getSignedUrl / delete` — narrow surface; all keys must
 *     pass `assertKeyForTenant` which runs the UUID-strict regex +
 *     tenant-prefix check (mirrors the DB CHECK).
 *   * `AppLogger` redirection via the existing Pino/Nest Logger;
 *     the prisma redactor extension covers AWS SDK credential leak
 *     shapes (accessKeyId, secretAccessKey, authorization).
 */
@Injectable()
export class ObjectStorageService implements OnModuleInit {
  private readonly log = new Logger('ObjectStorageService');
  private readonly cfg: ObjectStorageConfig;
  private readonly client: S3Client;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {
    this.cfg = loadObjectStorageConfig(process.env);
    const clientConfig: Record<string, unknown> = {
      region: this.cfg.region,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: {
        accessKeyId: this.cfg.accessKey,
        secretAccessKey: this.cfg.secretKey,
      },
      // AWS SDK v3 NodeHttpHandler does NOT follow redirects by default;
      // 3xx responses surface as errors, so we get the SSRF-against-
      // redirect guarantee without extra config.
      maxAttempts: 3,
    };
    if (this.cfg.endpoint) {
      clientConfig['endpoint'] = this.cfg.endpoint;
    }
    this.client = new S3Client(clientConfig);
  }

  async onModuleInit(): Promise<void> {
    await this.validateEndpointSsrf();
    await this.audit.record({
      action: 'panorama.boot.object_storage_configured',
      resourceType: 'object_storage',
      resourceId: null,
      tenantId: null,
      actorUserId: null,
      metadata: {
        endpoint: this.cfg.endpoint ?? '<aws-default>',
        region: this.cfg.region,
        bucket: this.cfg.bucketPhotos,
        forcePathStyle: this.cfg.forcePathStyle,
        signedUrlTtlSeconds: this.cfg.signedUrlTtlSeconds,
      },
    });
  }

  /**
   * SSRF guard. Called at bootstrap; also exported as a helper for
   * testability (sinon-free — inject a dns resolver in the future).
   */
  private async validateEndpointSsrf(): Promise<void> {
    if (!this.cfg.endpoint) {
      // Real AWS — no endpoint override, SDK uses s3.amazonaws.com
      // which we trust by definition.
      return;
    }

    const url = new URL(this.cfg.endpoint);
    const hostname = url.hostname;

    if (isForbiddenHostname(hostname)) {
      throw new Error(
        `S3_ENDPOINT hostname ${hostname} matches a forbidden metadata/internal suffix`,
      );
    }

    // DNS resolve every A + AAAA answer. Refuse if ANY hits a
    // private range — a single malicious A-record behind
    // attacker.example.com turns the endpoint into an SSRF pivot.
    const resolved = await this.resolveHost(hostname);
    for (const ip of resolved) {
      const privateV4 = isPrivateIPv4(ip);
      const privateV6 = isPrivateIPv6(ip);
      if (privateV4 || privateV6) {
        if (this.cfg.allowPrivateEndpoint && this.cfg.nodeEnv !== 'production') {
          this.log.warn(
            { hostname, ip, nodeEnv: this.cfg.nodeEnv },
            'object_storage_endpoint_private_accepted_dev',
          );
          continue;
        }
        throw new Error(
          `S3_ENDPOINT ${hostname} resolves to private/metadata IP ${ip} — refusing bootstrap`,
        );
      }
    }

    this.log.log(
      { hostname, addresses: resolved },
      'object_storage_endpoint_ssrf_ok',
    );
  }

  private async resolveHost(hostname: string): Promise<string[]> {
    // IP literals don't need DNS.
    if (/^(\d+\.){3}\d+$/.test(hostname) || hostname.includes(':')) {
      return [hostname.replace(/^\[|\]$/g, '')];
    }

    const answers: string[] = [];
    const results = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    for (const r of results) {
      if (r.status === 'fulfilled') answers.push(...r.value);
    }
    if (answers.length === 0) {
      throw new Error(`DNS resolution returned no addresses for ${hostname}`);
    }
    return answers;
  }

  /**
   * Defence-in-depth guard — throws if `key` doesn't match the exact
   * UUID-strict inspection-photo shape AND live under the tenant's
   * prefix. Mirrors the DB CHECK exactly; any bypass (e.g. a future
   * $executeRawUnsafe) would fail here before S3 sees the call.
   */
  assertKeyForTenant(key: string, tenantId: string): void {
    if (!INSPECTION_PHOTO_KEY_REGEX.test(key)) {
      throw new Error('object_storage_key_invalid_shape');
    }
    const prefix = `tenants/${tenantId}/`;
    if (!key.startsWith(prefix)) {
      throw new Error('object_storage_key_tenant_mismatch');
    }
  }

  /**
   * Upload a sanitised buffer. `sha256` is the precomputed digest
   * (over the sanitised bytes) — passed into the S3 request as
   * `ChecksumSHA256` so the server-side integrity check catches a
   * network corruption. Tenant prefix is re-verified.
   */
  async put(
    key: string,
    body: Buffer,
    opts: { contentType: string; sha256: string; tenantId: string },
  ): Promise<void> {
    this.assertKeyForTenant(key, opts.tenantId);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.cfg.bucketPhotos,
          Key: key,
          Body: body,
          ContentType: opts.contentType,
          CacheControl: 'private, no-store',
          // S3 expects base64-encoded SHA-256. The caller passes the
          // hex digest; convert for the header.
          ChecksumSHA256: Buffer.from(opts.sha256, 'hex').toString('base64'),
        }),
      );
    } catch (err) {
      this.log.error(
        { err: redactErr(err), key },
        'object_storage_put_failed',
      );
      throw new ServiceUnavailableException('storage_write_failed');
    }
  }

  /**
   * Mint a presigned GET URL scoped to the exact key + short TTL.
   * Response overrides force `Content-Disposition: attachment` +
   * `Content-Type: image/jpeg` so a browser can't interpret slipped-
   * through bytes as HTML.
   */
  async getSignedUrl(
    key: string,
    opts: { tenantId: string; expiresIn?: number; thumbnail?: boolean },
  ): Promise<string> {
    this.assertKeyForTenant(key, opts.tenantId);
    const ttl = opts.expiresIn
      ?? (opts.thumbnail ? 60 : this.cfg.signedUrlTtlSeconds);
    try {
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({
          Bucket: this.cfg.bucketPhotos,
          Key: key,
          ResponseContentDisposition: 'attachment; filename="photo.jpg"',
          ResponseContentType: 'image/jpeg',
        }),
        { expiresIn: ttl },
      );
    } catch (err) {
      this.log.error(
        { err: redactErr(err), key },
        'object_storage_presign_failed',
      );
      throw new ServiceUnavailableException('storage_presign_failed');
    }
  }

  /**
   * Hard-delete. Used by the retention sweep and the super-admin
   * GDPR break-glass. Idempotent — S3 returns 204 even on missing
   * keys, which the SDK surfaces as a successful empty response.
   */
  async delete(key: string, tenantId: string): Promise<void> {
    this.assertKeyForTenant(key, tenantId);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.cfg.bucketPhotos,
          Key: key,
        }),
      );
    } catch (err) {
      this.log.error(
        { err: redactErr(err), key },
        'object_storage_delete_failed',
      );
      throw new ServiceUnavailableException('storage_delete_failed');
    }
  }
}

/**
 * Scrub AWS SDK error shapes before logging. The SDK's errors can
 * carry `Authorization` headers + `$metadata.httpHeaders` which
 * occasionally contain signed credentials in trace builds. The
 * prisma redactor catches structured JSON; we also flatten the err
 * for log-line safety.
 */
function redactErr(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== 'object') return { raw: String(err) };
  const anyErr = err as Record<string, unknown>;
  return {
    name: anyErr['name'],
    message: anyErr['message'],
    code: (anyErr['$metadata'] as { httpStatusCode?: number } | undefined)
      ?.httpStatusCode,
    // NEVER include $metadata.httpHeaders; contains Authorization.
    // Never include config / credentials; contains access key.
  };
}
