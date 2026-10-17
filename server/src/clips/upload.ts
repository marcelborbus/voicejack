import fs from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import type { ClipAttribution, UploadClipResponse } from '@dub/shared';
import { sendError } from '../http/app.js';
import { LibraryError, type ClipLibrary } from './ClipLibrary.js';
import { hasFfmpeg, normalize, probe, resolveTrim, type JobOptions } from './normalize.js';

/**
 * The upload pipeline shared by `/api/admin` (V05) and `/api/my` (V06): stream the raw body to
 * a temp file (size-capped), ffprobe + trim check, create the `processing` row, then normalize
 * on the shared `ClipLibrary.jobs` queue (admin jobs first, one per user).
 */

/** Byte counter that errors once more than `max` bytes went through. */
function limit(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) cb(Object.assign(new Error('upload too large'), { statusCode: 413 }));
      else cb(null, chunk);
    },
  });
}

/** Lets a scope take raw video bodies as streams (never buffered). */
export function acceptRawVideo(scope: FastifyInstance): void {
  const passThrough = (
    _req: FastifyRequest,
    payload: Readable,
    done: (e: null, b: Readable) => void,
  ) => done(null, payload);
  scope.addContentTypeParser('application/octet-stream', passThrough);
  scope.addContentTypeParser(/^video\//, passThrough);
}

export function libraryFail(reply: FastifyReply, e: unknown) {
  if (e instanceof LibraryError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'CONFLICT' ? 409 : 400;
    return reply.status(status).send(sendError('INVALID', e.message));
  }
  throw e;
}

export function bad(reply: FastifyReply, message: string) {
  return reply.status(400).send(sendError('INVALID', message));
}

let ffmpeg: boolean | null = null;

export interface UploadOptions {
  clips: ClipLibrary;
  libraryId: string;
  query: {
    title: string;
    ss: number;
    t?: number;
    tags: string;
    author: string;
    source: string;
    license: string;
    licenseUrl?: string;
  };
  maxBytes: number;
  job: JobOptions;
  uploadedBy?: string | null;
  rightsConfirmedAt?: number | null;
  /** Last check after the body arrived and probed fine (quotas); a message refuses with 403. */
  admit?: () => string | null;
  /** Runs once the job is queued (upload counters). */
  onQueued?: () => void;
  /** Runs after normalizing succeeded; a message fails the clip (quota exceeded) and drops it. */
  afterNormalize?: (bytes: number) => string | null;
  logTag: string;
}

export async function handleUpload(
  req: FastifyRequest,
  reply: FastifyReply,
  o: UploadOptions,
): Promise<FastifyReply> {
  const { clips } = o;
  const mb = Math.round(o.maxBytes / 1024 / 1024);
  if (!(req.body && typeof (req.body as Readable).pipe === 'function')) {
    return bad(reply, 'send the video as the raw body (application/octet-stream)');
  }
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > o.maxBytes) {
    return reply.status(413).send(sendError('LIMIT', `upload is larger than ${mb} MB`));
  }
  let dir: string;
  try {
    dir = clips.uploadDir(o.libraryId);
  } catch (e) {
    return libraryFail(reply, e);
  }
  ffmpeg ??= hasFfmpeg();
  if (!ffmpeg) return reply.status(503).send(sendError('INVALID', 'ffmpeg is not installed'));
  const refused = clips.jobs.refusal(o.job);
  if (refused === 'owner') {
    return reply
      .status(429)
      .send(sendError('RATE_LIMITED', 'your previous upload is still processing'));
  }
  if (refused) {
    return reply.status(503).send(sendError('RATE_LIMITED', 'busy, try again in a minute'));
  }

  const tmpDir = path.join(clips.libraryDir!, '.tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${nanoid(16)}.upload`);
  let queued = false;
  try {
    try {
      await pipeline(req.body as Readable, limit(o.maxBytes), fs.createWriteStream(tmp));
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 413) {
        return reply.status(413).send(sendError('LIMIT', `upload is larger than ${mb} MB`));
      }
      throw e;
    }
    let input;
    let trim;
    try {
      input = await probe(tmp);
      trim = resolveTrim(input, { ss: o.query.ss, t: o.query.t });
    } catch (e) {
      return bad(reply, (e as Error).message);
    }
    const why = o.admit?.();
    if (why) return reply.status(403).send(sendError('LIMIT', why));
    const q = o.query;
    const attribution: ClipAttribution = {
      author: q.author.trim(),
      source: q.source.trim(),
      license: q.license.trim(),
    };
    if (q.licenseUrl?.trim()) attribution.licenseUrl = q.licenseUrl.trim();
    const tags = [
      ...new Set(
        q.tags
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter((t) => t && t.length <= 32),
      ),
    ].slice(0, 32);
    let up: { id: string; file: string; poster: string };
    try {
      up = clips.createUpload(o.libraryId, {
        title: q.title,
        tags,
        attribution,
        uploadedBy: o.uploadedBy ?? null,
        rightsConfirmedAt: o.rightsConfirmedAt ?? null,
      });
    } catch (e) {
      return libraryFail(reply, e);
    }
    const job = clips.jobs.push(async () => {
      const outFile = path.join(dir, up.file);
      const posterFile = path.join(dir, up.poster);
      try {
        const res = await normalize({ input: tmp, probe: input, trim, outFile, posterFile });
        const over = o.afterNormalize?.(res.bytes);
        if (over) {
          fs.rmSync(outFile, { force: true });
          fs.rmSync(posterFile, { force: true });
          clips.failUpload(up.id, over);
          return;
        }
        clips.finishUpload(up.id, res);
        req.log.info({ clip: up.id, ...res }, `${o.logTag}: clip normalized`);
      } catch (e) {
        req.log.warn({ clip: up.id, err: (e as Error).message }, `${o.logTag}: normalize failed`);
        clips.failUpload(up.id, (e as Error).message);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }, o.job);
    if (!job) {
      clips.failUpload(up.id, 'queue full');
      return reply.status(503).send(sendError('RATE_LIMITED', 'busy, try again later'));
    }
    queued = true;
    o.onQueued?.();
    void job.catch(() => {});
    const res: UploadClipResponse = { clip: clips.adminClip(up.id) };
    return reply.status(202).send(res);
  } finally {
    if (!queued) fs.rmSync(tmp, { force: true });
  }
}
