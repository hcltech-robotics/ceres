import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  CERES_EXPORT_CAPABILITY_HEADER,
  LEROBOT_EXPORT_MANIFEST_VERSION,
  type EpisodeExportBlob,
  type EpisodeExportBlobId,
  type EpisodeExportManifest,
  episodeExportFrameContribution,
  episodeExportTimeline,
  episodeTaskTexts,
  isExportableEpisode,
} from "../shared/lerobot-export.js";
import type { Episode } from "../shared/protocol.js";
import { verifyTaskSpecificationProvenance } from "../shared/task-specification.js";

const storageIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class EpisodeExportAccessError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "EpisodeExportAccessError";
  }
}

interface EpisodeRecord {
  episode: Episode;
  root: string;
}

export interface EpisodeExportAccessOptions {
  dataRoot?: string;
  recorderRateHz?: (sessionId: string) => number;
}

export class EpisodeExportAccess {
  private readonly dataRoot: string;
  private readonly recorderRateHz: (sessionId: string) => number;

  constructor(options: EpisodeExportAccessOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? process.env.CERES_DATA_DIR ?? "data");
    this.recorderRateHz = options.recorderRateHz ?? (() => 30);
  }

  async manifest(sessionId: string, episodeId: string): Promise<EpisodeExportManifest> {
    this.assertIdentifier(sessionId, "Session");
    this.assertIdentifier(episodeId, "Episode");
    const records = await this.readEpisodes(sessionId);
    const exportable = records
      .filter((record) => isExportableEpisode(record.episode))
      .sort((left, right) => compareEpisodes(left.episode, right.episode));
    const episodeIndex = exportable.findIndex((record) => record.episode.id === episodeId);
    if (episodeIndex < 0) {
      const known = records.find((record) => record.episode.id === episodeId);
      if (!known) throw new EpisodeExportAccessError(404, "Episode was not found");
      throw new EpisodeExportAccessError(409, "Only episodes with at least one durable sensor frame may be exported");
    }

    const record = exportable[episodeIndex];
    let taskSpecification;
    try {
      taskSpecification = await verifyTaskSpecificationProvenance(record.episode);
    } catch (error) {
      throw new EpisodeExportAccessError(
        409,
        error instanceof Error ? error.message : "Episode task specification provenance is invalid",
      );
    }
    const tasks = taskCatalogue(exportable.slice(0, episodeIndex + 1).map((entry) => entry.episode));
    const task = tasks.find((entry) => entry.text === episodeTaskTexts(record.episode)[0]);
    if (!task) throw new EpisodeExportAccessError(409, "Episode task metadata is incomplete");
    const fps = this.recorderRateHz(sessionId);
    if (!Number.isSafeInteger(fps) || fps <= 0 || fps > 1_000) {
      throw new EpisodeExportAccessError(409, "Episode recorder rate is invalid");
    }
    let globalFrameIndex: number;
    try {
      globalFrameIndex = exportable.slice(0, episodeIndex).reduce(
        (total, entry) => total + episodeExportFrameContribution(entry.episode),
        0,
      );
      episodeExportTimeline(record.episode);
    } catch (error) {
      throw new EpisodeExportAccessError(
        409,
        error instanceof Error ? error.message : "Episode export timeline is invalid",
      );
    }

    const blobs = await this.describeBlobs(sessionId, record);
    return {
      schemaVersion: LEROBOT_EXPORT_MANIFEST_VERSION,
      sessionId,
      episode: record.episode,
      episodeIndex,
      globalFrameIndex,
      fps,
      task,
      tasks,
      ...(taskSpecification
        ? {
            taskSpecVersion: record.episode.taskSpecVersion,
            taskSpecHash: record.episode.taskSpecHash,
            taskSpecification,
          }
        : {}),
      blobs,
    };
  }

  async blob(sessionId: string, episodeId: string, blobId: string): Promise<{ descriptor: EpisodeExportBlob; absolutePath: string }> {
    if (blobId !== "sensors" && blobId !== "video") throw new EpisodeExportAccessError(404, "Episode export blob was not found");
    const manifest = await this.manifest(sessionId, episodeId);
    const descriptor = manifest.blobs.find((entry) => entry.id === blobId);
    if (!descriptor) throw new EpisodeExportAccessError(404, "Episode export blob was not found");
    const root = this.episodeRoot(sessionId, episodeId);
    const absolutePath = path.resolve(root, descriptor.path);
    if (!isWithin(root, absolutePath)) throw new EpisodeExportAccessError(400, "Episode export blob path is invalid");
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(absolutePath)]);
    if (!isWithin(canonicalRoot, canonicalPath)) throw new EpisodeExportAccessError(400, "Episode export blob path is invalid");
    return { descriptor, absolutePath: canonicalPath };
  }

  private async describeBlobs(sessionId: string, record: EpisodeRecord): Promise<EpisodeExportBlob[]> {
    const route = `/api/sessions/${encodeURIComponent(sessionId)}/episodes/${encodeURIComponent(record.episode.id)}/export-blobs`;
    const sensorsPath = path.join(record.root, "sensors.jsonl");
    const sensors = await fileSize(sensorsPath, "Episode sensor rows were not found");
    if (sensors === 0) throw new EpisodeExportAccessError(409, "Episode sensor rows are empty");
    const blobs: EpisodeExportBlob[] = [{
      id: "sensors",
      path: "sensors.jsonl",
      url: `${route}/sensors`,
      mediaType: "application/x-ndjson",
      byteLength: sensors,
    }];
    const videoRoot = path.join(record.root, "video");
    let videoNames: string[] = [];
    try {
      videoNames = (await readdir(videoRoot)).filter((name) => /^passthrough\.(mp4|webm)$/.test(name)).sort();
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
    const videoName = videoNames[0];
    if (videoName) {
      blobs.push({
        id: "video",
        path: `video/${videoName}`,
        url: `${route}/video`,
        mediaType: videoName.endsWith(".mp4") ? "video/mp4" : "video/webm",
        byteLength: await fileSize(path.join(videoRoot, videoName), "Episode video was not found"),
      });
    }
    return blobs;
  }

  private async readEpisodes(sessionId: string): Promise<EpisodeRecord[]> {
    const root = path.join(this.dataRoot, "sessions", sessionId, "episodes");
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) throw new EpisodeExportAccessError(404, "Session episodes were not found");
      throw error;
    }
    const records: EpisodeRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !storageIdentifier.test(entry.name)) continue;
      const episodeRoot = path.join(root, entry.name);
      try {
        try {
          await stat(path.join(episodeRoot, "deleted.json"));
          continue;
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
        }
        let episode: Episode | null = null;
        for (const name of ["episode.json", "attempt.json"]) {
          try {
            episode = JSON.parse(await readFile(path.join(episodeRoot, name), "utf8")) as Episode;
            break;
          } catch (error) {
            if (!isFileSystemError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
          }
        }
        if (episode?.id === entry.name) records.push({ episode, root: episodeRoot });
      } catch (error) {
        if (!isFileSystemError(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
      }
    }
    return records;
  }

  private episodeRoot(sessionId: string, episodeId: string): string {
    return path.join(this.dataRoot, "sessions", sessionId, "episodes", episodeId);
  }

  private assertIdentifier(value: string, label: string): void {
    if (!storageIdentifier.test(value)) throw new EpisodeExportAccessError(400, `${label} identifier is invalid`);
  }
}

export type EpisodeExportAuthoriser = (sessionId: string, capability: string | undefined) => boolean;

export function createEpisodeExportRouter(access: EpisodeExportAccess, authorise: EpisodeExportAuthoriser): Router {
  const router = express.Router();
  router.get("/api/sessions/:sessionId/episodes/:episodeId/export-manifest", asyncRoute(async (request, response) => {
    const sessionId = routeParameter(request.params.sessionId);
    if (!authoriseExportRequest(request, response, sessionId, authorise)) return;
    response.setHeader("Cache-Control", "private, no-store");
    response.json(await access.manifest(sessionId, routeParameter(request.params.episodeId)));
  }));
  router.get("/api/sessions/:sessionId/episodes/:episodeId/export-blobs/:blobId", asyncRoute(async (request, response, next) => {
    const sessionId = routeParameter(request.params.sessionId);
    if (!authoriseExportRequest(request, response, sessionId, authorise)) return;
    const blob = await access.blob(
      sessionId,
      routeParameter(request.params.episodeId),
      routeParameter(request.params.blobId),
    );
    response.type(blob.descriptor.mediaType);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Length", String(blob.descriptor.byteLength));
    response.sendFile(blob.absolutePath, (error) => error ? next(error) : undefined);
  }));
  router.all("/api/sessions/:sessionId/episodes/:episodeId/export-manifest", methodNotAllowed);
  router.all("/api/sessions/:sessionId/episodes/:episodeId/export-blobs/:blobId", methodNotAllowed);
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof EpisodeExportAccessError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    next(error);
  });
  return router;
}

function authoriseExportRequest(
  request: Request,
  response: Response,
  sessionId: string,
  authorise: EpisodeExportAuthoriser,
): boolean {
  if (authorise(sessionId, request.get(CERES_EXPORT_CAPABILITY_HEADER))) return true;
  response.setHeader("Cache-Control", "private, no-store");
  response.status(401).json({ error: "Episode export authorisation is required" });
  return false;
}

function methodNotAllowed(_request: Request, response: Response): void {
  response.setHeader("Allow", "GET, HEAD");
  response.status(405).json({ error: "Episode export endpoints are read-only" });
}

function asyncRoute(handler: (request: Request, response: Response, next: NextFunction) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response, next).catch(next);
}

function routeParameter(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function taskCatalogue(episodes: Episode[]) {
  const texts: string[] = [];
  for (const episode of episodes) {
    for (const label of episodeTaskTexts(episode)) if (!texts.includes(label)) texts.push(label);
  }
  return texts.map((text, index) => ({ index, text }));
}

function compareEpisodes(left: Episode, right: Episode): number {
  return left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function fileSize(file: string, message: string): Promise<number> {
  try {
    const result = await stat(file);
    if (!result.isFile()) throw new EpisodeExportAccessError(404, message);
    return result.size;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) throw new EpisodeExportAccessError(404, message);
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
