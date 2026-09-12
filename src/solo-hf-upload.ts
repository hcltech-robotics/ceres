import {
  createBranch,
  createRepo,
  repoExists,
  uploadFilesWithProgress,
  type CommitOutput,
  type CommitProgressEvent,
  type RepoDesignation,
} from "@huggingface/hub";
import {
  sameHuggingFaceAppendAllocation,
  type AccountUploadManifestArtefact,
  type HuggingFaceAppendAllocation,
  type HuggingFaceMissingRepositoryBehaviour,
} from "../shared/export-destination.js";
import { readBrowserExportArtifact } from "./lerobot-export/storage.js";
import {
  inspectSoloHuggingFaceAppendAllocation,
  SoloHuggingFaceDestinationError,
} from "./solo-hf-destination.js";
import type { SoloHuggingFaceCredential } from "./solo-hf-oauth.js";

export interface SoloHuggingFaceUploadOptions {
  credential: SoloHuggingFaceCredential;
  sessionId: string;
  repository: string;
  branch: string;
  visibility: "public" | "private";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  appendAllocation?: HuggingFaceAppendAllocation;
  artefacts: readonly AccountUploadManifestArtefact[];
  signal: AbortSignal;
  onProgress: (
    completed: number,
    total: number,
    detail: string,
    stage: SoloHuggingFaceUploadStage,
  ) => void;
}

export type SoloHuggingFaceUploadStage =
  | "repository"
  | "reading"
  | "hashing"
  | "uploading"
  | "committing";

export interface SoloHuggingFaceUploadResult {
  commitOid: string;
  commitUrl: string;
}

export function soloHuggingFaceUploadErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/cannot read propert(?:y|ies) of undefined/i.test(message)) {
    return "Hugging Face returned an incomplete upload response. The upload was stopped. Retry manually when ready.";
  }
  return message;
}

export interface SoloHuggingFaceHubPort {
  repoExists(options: {
    repo: RepoDesignation;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<boolean>;
  createRepo(options: {
    repo: RepoDesignation;
    accessToken: string;
    visibility: "public" | "private";
    files?: Array<{ path: string; content: Blob | ArrayBuffer }>;
    signal: AbortSignal;
  }): Promise<{ repoUrl: string; id: string }>;
  createBranch(options: {
    repo: RepoDesignation;
    branch: string;
    accessToken: string;
    overwrite: boolean;
    signal: AbortSignal;
  }): Promise<void>;
  uploadFilesWithProgress(options: {
    repo: RepoDesignation;
    accessToken: string;
    branch: string;
    files: Array<{ path: string; content: File }>;
    commitTitle: string;
    parentCommit?: string;
    abortSignal: AbortSignal;
    useWebWorkers: boolean | { minSize?: number; poolSize?: number };
  }): AsyncGenerator<CommitProgressEvent, CommitOutput | undefined>;
  inspectAppendAllocation?(options: {
    repository: string;
    branch: string;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<HuggingFaceAppendAllocation | null>;
  inspectVisibility?(options: {
    repository: string;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<"public" | "private">;
  occupiedPaths?(options: {
    repository: string;
    revision: string;
    paths: readonly string[];
    accessToken: string;
    signal: AbortSignal;
  }): Promise<string[]>;
  readDatasetCard?(options: {
    repository: string;
    branch: string;
    accessToken: string;
    signal: AbortSignal;
  }): Promise<string | null>;
  readArtifact(sessionId: string, path: string): Promise<File>;
}

const fetchWithSignal = (signal: AbortSignal): typeof fetch => (
  input,
  init,
) => fetch(input, { ...init, signal });

const defaultHubPort: SoloHuggingFaceHubPort = {
  repoExists: ({ signal, ...options }) => repoExists({
    ...options,
    fetch: fetchWithSignal(signal),
  }),
  createRepo: ({ signal, ...options }) => createRepo({
    ...options,
    fetch: fetchWithSignal(signal),
  }),
  createBranch: ({ signal, ...options }) => createBranch({
    ...options,
    fetch: fetchWithSignal(signal),
  }),
  uploadFilesWithProgress,
  inspectAppendAllocation: async (options) => {
    try {
      return await inspectSoloHuggingFaceAppendAllocation(options);
    } catch (error) {
      if (error instanceof SoloHuggingFaceDestinationError && error.code === "not-found") {
        return null;
      }
      throw error;
    }
  },
  inspectVisibility: async ({ repository, accessToken, signal }) => {
    const response = await fetch(`https://huggingface.co/api/datasets/${repository}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw new Error("The Hugging Face dataset visibility could not be inspected");
    const value = await response.json() as { private?: unknown };
    if (typeof value.private !== "boolean") {
      throw new Error("Hugging Face returned invalid repository metadata");
    }
    return value.private ? "private" : "public";
  },
  occupiedPaths: async ({ repository, revision, paths, accessToken, signal }) => {
    const occupied: string[] = [];
    for (let offset = 0; offset < paths.length; offset += 500) {
      const body = new URLSearchParams();
      for (const path of paths.slice(offset, offset + 500)) body.append("paths", path);
      body.set("expand", "false");
      const response = await fetch(
        `https://huggingface.co/api/datasets/${repository}/paths-info/${revision}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok) throw new Error("Hugging Face upload targets could not be inspected");
      const entries = await response.json() as unknown;
      if (!Array.isArray(entries)) {
        throw new Error("Hugging Face returned invalid upload target information");
      }
      for (const entry of entries) {
        if (
          !entry
          || typeof entry !== "object"
          || Array.isArray(entry)
          || typeof (entry as { path?: unknown }).path !== "string"
        ) {
          throw new Error("Hugging Face returned invalid upload target information");
        }
        occupied.push((entry as { path: string }).path);
      }
    }
    return occupied;
  },
  readDatasetCard: async ({ repository, branch, accessToken, signal }) => {
    const [namespace, name] = repository.split("/");
    if (!namespace || !name) throw new Error("The Hugging Face dataset repository is invalid");
    const response = await fetch(
      `https://huggingface.co/datasets/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/resolve/${encodeURIComponent(branch)}/README.md`,
      { headers: { Authorization: `Bearer ${accessToken}` }, signal },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("The Hugging Face dataset card could not be read");
    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > 1_048_576) {
      throw new Error("The Hugging Face dataset card is too large to update safely");
    }
    const card = await response.text();
    if (card.length > 1_048_576) throw new Error("The Hugging Face dataset card is too large to update safely");
    return card;
  },
  readArtifact: readBrowserExportArtifact,
};

const soloAppendRootPath = ".ceres/append-root-v1.txt";
const soloAppendRootContent = "CERES append root v1\n";

function isHuggingFaceConflict(error: unknown) {
  return error !== null
    && typeof error === "object"
    && (error as { statusCode?: unknown }).statusCode === 409;
}

function appendAllocationMatchesRequest(
  requested: HuggingFaceAppendAllocation,
  current: HuggingFaceAppendAllocation,
) {
  if (requested.repositoryRevision !== null) {
    return sameHuggingFaceAppendAllocation(requested, current);
  }
  return requested.nextEpisodeIndex === 0
    && requested.nextGlobalFrameIndex === 0
    && current.nextEpisodeIndex === 0
    && current.nextGlobalFrameIndex === 0;
}

async function createSoloAppendRoot(input: {
  port: SoloHuggingFaceHubPort;
  repo: RepoDesignation;
  branch: string;
  accessToken: string;
  signal: AbortSignal;
}) {
  const iterator = input.port.uploadFilesWithProgress({
    repo: input.repo,
    accessToken: input.accessToken,
    branch: input.branch,
    files: [{
      path: soloAppendRootPath,
      content: new File([soloAppendRootContent], "append-root-v1.txt", { type: "text/plain" }),
    }],
    commitTitle: "Initialise CERES append root",
    abortSignal: input.signal,
    useWebWorkers: false,
  });
  let result: CommitOutput | undefined;
  while (true) {
    input.signal.throwIfAborted();
    const next = await iterator.next();
    if (!next.done) continue;
    result = next.value;
    break;
  }
  if (
    typeof result?.commit?.oid !== "string"
    || !result.commit.oid
    || typeof result.commit.url !== "string"
    || !result.commit.url
  ) {
    throw new Error("Hugging Face did not establish a durable append root");
  }
}

export async function uploadSoloHuggingFaceExport(
  options: SoloHuggingFaceUploadOptions,
  port: SoloHuggingFaceHubPort = defaultHubPort,
): Promise<SoloHuggingFaceUploadResult> {
  options.signal.throwIfAborted();
  const repo = { type: "dataset", name: options.repository } satisfies RepoDesignation;
  const accessToken = options.credential.accessToken;
  options.onProgress(0, 1, "Checking Hugging Face dataset", "repository");
  const repositoryExisted = await port.repoExists({ repo, accessToken, signal: options.signal });
  let repositoryCreated = false;
  if (!repositoryExisted) {
    options.signal.throwIfAborted();
    const missingRepositoryBehaviour = options.missingRepositoryBehaviour ?? options.visibility;
    if (missingRepositoryBehaviour === "do-not-create") {
      throw new Error("The Hugging Face dataset repository does not exist");
    }
    try {
      await port.createRepo({
        repo,
        accessToken,
        visibility: missingRepositoryBehaviour,
        files: [{
          path: soloAppendRootPath,
          content: new Blob([soloAppendRootContent], { type: "text/plain" }),
        }],
        signal: options.signal,
      });
      repositoryCreated = true;
    } catch (error) {
      if (!isHuggingFaceConflict(error)) throw error;
    }
  }
  options.signal.throwIfAborted();
  if (options.branch !== "main" && repositoryCreated) {
    if (port.inspectAppendAllocation) {
      let mainAllocation = await port.inspectAppendAllocation({
        repository: options.repository,
        branch: "main",
        accessToken,
        signal: options.signal,
      });
      if (!mainAllocation) {
        await createSoloAppendRoot({
          port,
          repo,
          branch: "main",
          accessToken,
          signal: options.signal,
        });
        mainAllocation = await port.inspectAppendAllocation({
          repository: options.repository,
          branch: "main",
          accessToken,
          signal: options.signal,
        });
      }
      if (
        !mainAllocation
        || mainAllocation.nextEpisodeIndex !== 0
        || mainAllocation.nextGlobalFrameIndex !== 0
      ) {
        throw new Error("The Hugging Face dataset changed after export allocation");
      }
    }
    await port.createBranch({
      repo,
      branch: options.branch,
      accessToken,
      overwrite: false,
      signal: options.signal,
    });
  }
  options.signal.throwIfAborted();

  let pinnedAllocation: HuggingFaceAppendAllocation | null = null;
  let parentCommit: string | undefined;
  if (port.inspectAppendAllocation) {
    let currentAllocation = await port.inspectAppendAllocation({
      repository: options.repository,
      branch: options.branch,
      accessToken,
      signal: options.signal,
    });
    if (!currentAllocation) {
      if (!repositoryCreated) {
        throw new Error("The Hugging Face dataset changed after export allocation");
      }
      await createSoloAppendRoot({
        port,
        repo,
        branch: options.branch,
        accessToken,
        signal: options.signal,
      });
      currentAllocation = await port.inspectAppendAllocation({
        repository: options.repository,
        branch: options.branch,
        accessToken,
        signal: options.signal,
      });
    }
    if (
      !currentAllocation
      || !currentAllocation.repositoryRevision
      || (
        options.appendAllocation
        && !appendAllocationMatchesRequest(options.appendAllocation, currentAllocation)
      )
    ) {
      throw new Error("The Hugging Face dataset changed after export allocation");
    }
    assertArtefactAllocation(options.artefacts, options.appendAllocation ?? currentAllocation);
    pinnedAllocation = currentAllocation;
    parentCommit = currentAllocation.repositoryRevision;
    if (port.occupiedPaths) {
      const occupied = await port.occupiedPaths({
        repository: options.repository,
        revision: parentCommit,
        paths: options.artefacts.map((artefact) => artefact.path),
        accessToken,
        signal: options.signal,
      });
      if (occupied.length > 0) {
        throw new Error("The Hugging Face upload target is already occupied");
      }
    }
  } else if (options.appendAllocation) {
    const emptyAllocation = {
      nextEpisodeIndex: 0,
      nextGlobalFrameIndex: 0,
      repositoryRevision: null,
    } satisfies HuggingFaceAppendAllocation;
    if (!sameHuggingFaceAppendAllocation(options.appendAllocation, emptyAllocation)) {
      throw new Error("The Hugging Face dataset changed after export allocation");
    }
    assertArtefactAllocation(options.artefacts, options.appendAllocation);
  }

  const totalBytes = Math.max(1, options.artefacts.reduce(
    (total, artefact) => total + artefact.byteLength,
    0,
  ));
  const totalWork = totalBytes * 2;
  let loadedBytes = 0;
  const files: Array<{ path: string; content: File }> = [];
  const episodeMetadata: unknown[] = [];
  for (const [index, artefact] of options.artefacts.entries()) {
    options.signal.throwIfAborted();
    const content = await port.readArtifact(options.sessionId, artefact.path);
    if (artefact.path.endsWith("/ceres/episode-metadata.json")) {
      try {
        episodeMetadata.push(JSON.parse(await content.text()) as unknown);
      } catch {
        // The export artefact remains uploadable, but cannot contribute to the optional card summary.
      }
    }
    files.push({
      path: artefact.path,
      content,
    });
    options.signal.throwIfAborted();
    loadedBytes += artefact.byteLength;
    options.onProgress(
      Math.min(totalBytes, loadedBytes),
      totalWork,
      `Reading export artefact ${index + 1}/${options.artefacts.length} from headset storage`,
      "reading",
    );
  }

  const existingCard = port.readDatasetCard
    ? await port.readDatasetCard({
        repository: options.repository,
        branch: options.branch,
        accessToken,
        signal: options.signal,
      })
    : null;
  const { updateCeresDatasetCard } = await import("../shared/dataset-card.js");
  const card = await updateCeresDatasetCard(existingCard, options.repository, episodeMetadata);
  if (card.action !== "preserve") {
    files.push({ path: "README.md", content: new File([card.content], "README.md", { type: "text/markdown" }) });
  }

  if (pinnedAllocation && port.inspectAppendAllocation) {
    const confirmedAllocation = await port.inspectAppendAllocation({
      repository: options.repository,
      branch: options.branch,
      accessToken,
      signal: options.signal,
    });
    if (
      !confirmedAllocation
      || !sameHuggingFaceAppendAllocation(pinnedAllocation, confirmedAllocation)
    ) {
      throw new Error("The Hugging Face dataset changed while upload artefacts were being prepared");
    }
    if (port.occupiedPaths) {
      const occupied = await port.occupiedPaths({
        repository: options.repository,
        revision: pinnedAllocation.repositoryRevision!,
        paths: options.artefacts.map((artefact) => artefact.path),
        accessToken,
        signal: options.signal,
      });
      if (occupied.length > 0) {
        throw new Error("The Hugging Face upload target is already occupied");
      }
    }
  }

  const fileProgress = new Map<string, number>();
  let reportedCompleted = loadedBytes;
  let visibilityVerified = false;
  const iterator = port.uploadFilesWithProgress({
    repo,
    accessToken,
    branch: options.branch,
    files,
    commitTitle: `Upload CERES capture ${options.sessionId}`,
    parentCommit,
    abortSignal: options.signal,
    // Quest has limited CPU and memory headroom while the XR scene remains active.
    // A single, larger-background hashing worker deliberately favours responsiveness.
    useWebWorkers: { minSize: 1_024 * 1_024, poolSize: 1 },
  });
  let result: CommitOutput | undefined;
  while (true) {
    options.signal.throwIfAborted();
    const next = await iterator.next();
    if (next.done) {
      result = next.value;
      break;
    }
    const event = next.value;
    if (!event || typeof event !== "object") {
      throw new Error("Hugging Face returned an incomplete upload response");
    }
    if (event.event === "fileProgress") {
      fileProgress.set(event.path, Math.max(0, Math.min(1, event.progress)));
      const completed = options.artefacts.reduce(
        (total, artefact) => total + artefact.byteLength * (fileProgress.get(artefact.path) ?? 0),
        0,
      );
      reportedCompleted = Math.max(reportedCompleted, Math.min(totalWork, totalBytes + completed));
      options.onProgress(
        reportedCompleted,
        totalWork,
        `${event.state === "hashing" ? "Hashing" : "Uploading"} ${event.path}`,
        event.state === "hashing" ? "hashing" : "uploading",
      );
      continue;
    }
    if (event.phase === "committing" && port.inspectVisibility && !visibilityVerified) {
      const currentVisibility = await port.inspectVisibility({
        repository: options.repository,
        accessToken,
        signal: options.signal,
      });
      if (currentVisibility !== options.visibility) {
        throw new Error("The Hugging Face repository visibility changed before commit");
      }
      visibilityVerified = true;
    }
    if (event.phase === "committing") reportedCompleted = Math.max(reportedCompleted, totalWork - 1);
    options.onProgress(
      reportedCompleted,
      totalWork,
      event.phase === "committing" ? "Committing Hugging Face dataset" : "Preparing Hugging Face upload",
      event.phase === "committing" ? "committing" : "repository",
    );
  }
  const commit = result?.commit;
  if (
    !commit
    || typeof commit.oid !== "string"
    || !commit.oid
    || typeof commit.url !== "string"
    || !commit.url
  ) {
    throw new Error("Hugging Face did not return a verified dataset commit");
  }
  options.onProgress(totalWork, totalWork, "Hugging Face dataset committed", "committing");
  return {
    commitOid: commit.oid,
    commitUrl: commit.url,
  };
}

function assertArtefactAllocation(
  artefacts: readonly AccountUploadManifestArtefact[],
  allocation: HuggingFaceAppendAllocation,
) {
  const episodeIndices = [...new Set(artefacts.flatMap(({ path }) => {
    const match = /^shards\/episode-(\d{6,})\//.exec(path);
    if (!match) {
      if (path.startsWith("shards/episode-")) {
        throw new Error("The exported episode path is not canonical");
      }
      return [];
    }
    const index = Number(match[1]);
    if (
      !Number.isSafeInteger(index)
      || index < 0
      || match[1] !== String(index).padStart(6, "0")
    ) {
      throw new Error("The exported episode path is not canonical");
    }
    return [index];
  }))].sort((left, right) => left - right);
  if (episodeIndices.length === 0) {
    throw new Error("The prepared export does not contain an immutable episode shard");
  }
  for (const [offset, episodeIndex] of episodeIndices.entries()) {
    if (episodeIndex !== allocation.nextEpisodeIndex + offset) {
      throw new Error("The exported episode paths do not match the Hugging Face append allocation");
    }
  }
}
