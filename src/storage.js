import { randomUUID } from 'node:crypto';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * ImageStore: the only place that knows about S3 / Neon Object Storage.
 * Swapping the provider later means re-implementing these methods, nothing else.
 */
export function createImageStore(cfg) {
  const s3 = new S3Client({
    endpoint: cfg.NEON_S3_ENDPOINT,
    region: cfg.NEON_S3_REGION,
    forcePathStyle: true, // Neon Object Storage is path-style only
    credentials: {
      accessKeyId: cfg.NEON_S3_ACCESS_KEY_ID,
      secretAccessKey: cfg.NEON_S3_SECRET_ACCESS_KEY,
    },
  });
  const Bucket = cfg.NEON_S3_BUCKET;
  const presign = (Key, expiresIn) => getSignedUrl(s3, new GetObjectCommand({ Bucket, Key }), { expiresIn });

  return {
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({
        Bucket, Key: key, Body: body, ContentType: contentType,
        // Keys are never reused, so the content is immutable.
        CacheControl: 'public, max-age=31536000, immutable',
      }));
    },

    // S3 DeleteObject succeeds for keys that do not exist, so this is idempotent.
    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    // Whole object as a Buffer (used for the shop logo inside PDFs; images are <= 1024 px WebP).
    async get(key) {
      const res = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },

    async signedUrl(key, expiresInSeconds = 600) {
      return presign(key, expiresInSeconds);
    },

    // [{ key, lastModified: Date }] for every object under the prefix (pages through the listing).
    async list(prefix) {
      const out = [];
      let ContinuationToken;
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }));
        for (const o of res.Contents ?? []) out.push({ key: o.Key, lastModified: o.LastModified });
        ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (ContinuationToken);
      return out;
    },

    // Put -> get -> compare -> presigned GET -> delete. Proves credentials, endpoint, bucket AND presigned-URL support.
    async selfTest() {
      const Key = `_healthcheck/${randomUUID()}.txt`;
      const payload = `ok-${Date.now()}`;
      const started = Date.now();
      let presigned = false;
      await s3.send(new PutObjectCommand({ Bucket, Key, Body: payload, ContentType: 'text/plain' }));
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket, Key }));
        if ((await res.Body.transformToString()) !== payload) {
          throw new Error('Round-trip content mismatch');
        }
        try {
          const r = await fetch(await presign(Key, 60));
          presigned = r.ok && (await r.text()) === payload;
        } catch {
          presigned = false;
        }
      } finally {
        await s3.send(new DeleteObjectCommand({ Bucket, Key }));
      }
      return { ok: true, ms: Date.now() - started, presigned };
    },
  };
}
