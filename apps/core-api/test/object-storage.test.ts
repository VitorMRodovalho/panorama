import { describe, expect, it } from 'vitest';
import {
  INSPECTION_PHOTO_KEY_REGEX,
  inspectionPhotoKey,
  tenantIdFromInspectionPhotoKey,
} from '../src/modules/object-storage/object-storage.keys.js';
import {
  isForbiddenHostname,
  isPrivateIPv4,
  isPrivateIPv6,
  loadObjectStorageConfig,
} from '../src/modules/object-storage/object-storage.config.js';

/**
 * ObjectStorage unit coverage (ADR-0012).
 *
 * Tests are scoped to the pure-function surface — key construction,
 * SSRF classifiers, config loader. The client itself (S3Client,
 * getSignedUrl) is exercised by the inspection-photo integration
 * test where it can use the MinIO container.
 */

describe('inspectionPhotoKey', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const inspectionId = '22222222-2222-4222-8222-222222222222';
  const photoId = '33333333-3333-4333-8333-333333333333';

  it('produces a key that matches the DB CHECK regex', () => {
    const key = inspectionPhotoKey(tenantId, inspectionId, photoId);
    expect(key).toBe(
      `tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}.jpg`,
    );
    // Round-trip assertion — helper output MUST always pass the
    // DB CHECK's regex. If this ever breaks, either the helper or
    // the CHECK drifted; both must be updated in lock-step.
    expect(INSPECTION_PHOTO_KEY_REGEX.test(key)).toBe(true);
  });

  it('rejects non-UUID tenantId', () => {
    expect(() => inspectionPhotoKey('not-a-uuid', inspectionId, photoId))
      .toThrow();
  });

  it('rejects path-traversal tenantId attempt', () => {
    expect(() => inspectionPhotoKey('../../other', inspectionId, photoId))
      .toThrow();
  });

  it('rejects non-UUID photoId', () => {
    expect(() => inspectionPhotoKey(tenantId, inspectionId, 'abc.jpg'))
      .toThrow();
  });

  it('regex rejects malformed keys', () => {
    // Missing extension
    expect(INSPECTION_PHOTO_KEY_REGEX.test(`tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}`))
      .toBe(false);
    // Wrong extension
    expect(INSPECTION_PHOTO_KEY_REGEX.test(`tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}.png`))
      .toBe(false);
    // Path-traversal-shaped
    expect(INSPECTION_PHOTO_KEY_REGEX.test(`tenants/${tenantId}/../other/photos/x.jpg`))
      .toBe(false);
    // Leading slash
    expect(INSPECTION_PHOTO_KEY_REGEX.test(`/tenants/${tenantId}/inspections/${inspectionId}/photos/${photoId}.jpg`))
      .toBe(false);
  });

  it('tenantIdFromInspectionPhotoKey extracts the tenant segment', () => {
    const key = inspectionPhotoKey(tenantId, inspectionId, photoId);
    expect(tenantIdFromInspectionPhotoKey(key)).toBe(tenantId);
    expect(tenantIdFromInspectionPhotoKey('garbage')).toBe(null);
  });
});

describe('SSRF classifiers', () => {
  it('flags RFC 1918 private IPv4 ranges', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.255.255.255')).toBe(true);
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    expect(isPrivateIPv4('192.168.0.1')).toBe(true);
  });

  it('flags loopback IPv4', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('127.255.255.255')).toBe(true);
  });

  it('flags AWS IMDS / link-local IPv4', () => {
    expect(isPrivateIPv4('169.254.169.254')).toBe(true);
    expect(isPrivateIPv4('169.254.0.1')).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
    expect(isPrivateIPv4('172.32.0.0')).toBe(false); // just outside 172.16/12
  });

  it('flags IPv6 loopback + ULA + link-local', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
    expect(isPrivateIPv6('fe80::1')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
  });

  it('flags metadata + internal FQDN suffixes', () => {
    expect(isForbiddenHostname('metadata.google.internal')).toBe(true);
    expect(isForbiddenHostname('metadata.azure.com')).toBe(true);
    expect(isForbiddenHostname('minio.svc.internal')).toBe(true);
    expect(isForbiddenHostname('db.local')).toBe(true);
    expect(isForbiddenHostname('s3.amazonaws.com')).toBe(false);
    expect(isForbiddenHostname('minio.localhost')).toBe(false); // not .localdomain
  });
});

describe('loadObjectStorageConfig', () => {
  const baseEnv = {
    NODE_ENV: 'development',
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET_PHOTOS: 'panorama-photos',
    S3_ACCESS_KEY: 'minioadmin',
    S3_SECRET_KEY: 'minioadmin',
    S3_FORCE_PATH_STYLE: 'true',
    S3_SIGNED_URL_TTL_SECONDS: '300',
    S3_ALLOW_PRIVATE_ENDPOINT: 'true',
  };

  it('parses a valid MinIO dev config', () => {
    const cfg = loadObjectStorageConfig(baseEnv);
    expect(cfg.endpoint).toBe('http://localhost:9000');
    expect(cfg.bucketPhotos).toBe('panorama-photos');
    expect(cfg.forcePathStyle).toBe(true);
    expect(cfg.signedUrlTtlSeconds).toBe(300);
    expect(cfg.allowPrivateEndpoint).toBe(true);
  });

  it('rejects http endpoint in production', () => {
    expect(() =>
      loadObjectStorageConfig({
        ...baseEnv,
        NODE_ENV: 'production',
        S3_ENDPOINT: 'http://minio.example.com',
      }),
    ).toThrow(/must use https/);
  });

  it('allows https endpoint in production', () => {
    const cfg = loadObjectStorageConfig({
      ...baseEnv,
      NODE_ENV: 'production',
      S3_ENDPOINT: 'https://s3.us-east-1.amazonaws.com',
      S3_ALLOW_PRIVATE_ENDPOINT: 'false',
    });
    expect(cfg.endpoint).toBe('https://s3.us-east-1.amazonaws.com');
  });

  it('allows missing endpoint (real AWS default)', () => {
    const { S3_ENDPOINT: _drop, ...noEndpoint } = baseEnv;
    const cfg = loadObjectStorageConfig({ ...noEndpoint, NODE_ENV: 'production' });
    expect(cfg.endpoint).toBeUndefined();
  });

  it('requires bucket + credentials', () => {
    expect(() =>
      loadObjectStorageConfig({ ...baseEnv, S3_BUCKET_PHOTOS: '' }),
    ).toThrow();
    expect(() =>
      loadObjectStorageConfig({ ...baseEnv, S3_ACCESS_KEY: '' }),
    ).toThrow();
    expect(() =>
      loadObjectStorageConfig({ ...baseEnv, S3_SECRET_KEY: '' }),
    ).toThrow();
  });

  it('treats truthy env strings consistently', () => {
    expect(loadObjectStorageConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: 'true' }).forcePathStyle).toBe(true);
    expect(loadObjectStorageConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: 'false' }).forcePathStyle).toBe(false);
    expect(loadObjectStorageConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: '0' }).forcePathStyle).toBe(false);
    expect(loadObjectStorageConfig({ ...baseEnv, S3_FORCE_PATH_STYLE: 'no' }).forcePathStyle).toBe(false);
  });
});
