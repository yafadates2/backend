import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { fileTypeFromBuffer } from 'file-type';

export const KINDS = ['products', 'categories', 'shop', 'expenses'];
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const KEY_RE = /^(products|categories|shop|expenses)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;

export const isValidKey = (k) => typeof k === 'string' && KEY_RE.test(k);

export class ImageError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Validates by magic bytes (the client-sent name / content-type is ignored), then re-encodes to
 * WebP <= 1024 px. Re-encoding drops EXIF (GPS etc.) and neutralises polyglot files.
 */
export async function normalizeImage(buffer) {
  const type = await fileTypeFromBuffer(buffer);
  if (!type || !ALLOWED_MIME.has(type.mime)) {
    throw new ImageError('Unsupported image type', 415, 'image_type');
  }
  try {
    return await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate() // apply EXIF orientation before metadata is dropped
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new ImageError('Corrupt or unsupported image', 422, 'image_corrupt');
  }
}

/**
 * Mounted under /images AFTER requireAuth + requireMember.
 *   POST   /images                multipart: file + kind  -> { key }     (always a NEW key)
 *   DELETE /images/:kind/:name                              -> { deleted } (409 if still referenced)
 *   GET    /images/signed?key=                              -> { url, expiresAt }
 * There is deliberately no PUT: replacing an image = POST a new one, point Firestore at it, then DELETE
 * the old key. Reusing a key would make the on-device cache (keyed by objectKey) serve stale images.
 */
export function createImagesRouter({ imageStore, isReferenced, logger, limiters = {} }) {
  const router = express.Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6 },
  });
  const noop = (_req, _res, next) => next();
  const receive = (req, res, next) =>
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
          error: tooBig ? 'Image too large' : 'Bad upload',
          code: tooBig ? 'image_too_large' : 'bad_upload',
        });
      }
      return next(err);
    });

  const handle = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ImageError) return res.status(err.status).json({ error: err.message, code: err.code });
      return next(err);
    }
  };

  router.post('/', limiters.write ?? noop, receive, handle(async (req, res) => {
    const kind = req.body?.kind;
    if (!KINDS.includes(kind)) throw new ImageError('Invalid kind', 400, 'invalid_kind');
    if (!req.file?.buffer?.length) throw new ImageError('No file', 400, 'no_file');
    const webp = await normalizeImage(req.file.buffer);
    const key = `${kind}/${randomUUID()}.webp`;
    await imageStore.put(key, webp, 'image/webp');
    res.status(201).json({ key });
  }));

  router.get('/signed', limiters.read ?? noop, handle(async (req, res) => {
    const key = req.query.key;
    if (!isValidKey(key)) throw new ImageError('Invalid key', 400, 'invalid_key');
    const ttl = 600;
    const url = await imageStore.signedUrl(key, ttl);
    res.json({ url, expiresAt: Date.now() + ttl * 1000 });
  }));

  router.delete('/:kind/:name', limiters.write ?? noop, handle(async (req, res) => {
    const key = `${req.params.kind}/${req.params.name}`;
    if (!isValidKey(key)) throw new ImageError('Invalid key', 400, 'invalid_key');
    // Never delete an image that a product / category / the shop logo still points to.
    if (await isReferenced(key)) throw new ImageError('Image is still in use', 409, 'image_in_use');
    await imageStore.delete(key);
    logger.info({ key }, 'image deleted');
    res.json({ deleted: true });
  }));

  return router;
}
