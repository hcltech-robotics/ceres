export const ACCOUNT_EXPORT_API_VERSION = 1 as const;

export const ACCOUNT_EXPORT_MAX_REGULAR_ARTEFACT_BYTES = 1 * 1_024 * 1_024;

export const ACCOUNT_EXPORT_MAX_ARTEFACT_BYTES = 500 * 1_024 * 1_024;

export const ACCOUNT_EXPORT_MAX_EPISODES = 100;

export const HUGGING_FACE_REPOSITORY_ACCESS_VERSION = 1;

const HUGGING_FACE_REPOSITORY_ACCESS_SCOPES = [
  "write-repos",
  "contribute-repos",
] as const;


export function huggingFaceTokenScopeAllowsRepositoryAccess(scope: unknown) {
  if (scope === undefined) return true;
  if (typeof scope !== "string" || scope.length > 1_024) return false;
  const granted = new Set(scope.trim().split(/\s+/).filter(Boolean));
  return HUGGING_FACE_REPOSITORY_ACCESS_SCOPES.every((required) => granted.has(required));
}


export function huggingFaceTokenRoleCanCreateRepositories(role: unknown) {
  return role === "admin" || role === "write" || role === "contributor";
}


export function huggingFaceOrganisationRoleCanCreateRepositories(role: unknown) {
  return role === "admin" || role === "write" || role === "contributor";
}


export type HuggingFaceConnectionState =
  | "disconnected"
  | "ready"
  | "reauthentication_required";


export type HuggingFaceMissingRepositoryBehaviour =
  | "do-not-create"
  | "private"
  | "public";


export interface AccountExportSession {
  version: typeof ACCOUNT_EXPORT_API_VERSION;
  signedIn: boolean;
  subject?: string | null;
  huggingFace: {
    state: HuggingFaceConnectionState;
    subject?: string | null;
    username: string | null;
  };
  defaults: {
    organisation: string;
    repositoryPrefix: string;
    visibility: "private" | "public";
  };
}


export interface AccountExportRepositoryCatalogue {
  version: typeof ACCOUNT_EXPORT_API_VERSION;
  organisations: string[];
  repositories: string[];
}


export interface AccountExportDestinationValidationRequest {
  organisation: string;
  repository: string;
  branch: string;
  visibility: "private" | "public";
  missingRepositoryBehaviour: HuggingFaceMissingRepositoryBehaviour;
}


export interface HuggingFaceAppendAllocation {
  nextEpisodeIndex: number;
  nextGlobalFrameIndex: number;
  repositoryRevision: string | null;
}


export interface AccountExportDestinationValidation {
  version: typeof ACCOUNT_EXPORT_API_VERSION;
  repository: string;
  branch: string;
  availability: "existing" | "creatable";
  visibility: "private" | "public";
  append: HuggingFaceAppendAllocation;
}


const huggingFaceEpisodeShardPattern = /^shards\/episode-(\d{6,})$/;

const huggingFaceEpisodeShardPrefix = "shards/episode-";

const huggingFaceRepositoryRevisionPattern = /^[a-f0-9]{40,64}$/;

const httpLinkParameterTokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+/;


export function huggingFaceEpisodeShardIndex(path: string): number | null {
  const match = huggingFaceEpisodeShardPattern.exec(path);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index)
    && index >= 0
    && match[1] === String(index).padStart(6, "0")
    ? index
    : null;
}


export function huggingFaceAppendAllocation(input: {
  repositoryRevision: string | null;
  shardPaths: readonly string[];
  latestTotalFrames?: unknown;
  latestTotalEpisodes?: unknown;
}): HuggingFaceAppendAllocation {
  if (
    input.repositoryRevision !== null
    && !huggingFaceRepositoryRevisionPattern.test(input.repositoryRevision)
  ) {
    throw new Error("The Hugging Face repository revision is invalid");
  }
  const seenEpisodeIndices = new Set<number>();
  const episodeIndices = input.shardPaths.flatMap((path) => {
    const index = huggingFaceEpisodeShardIndex(path);
    if (index === null) {
      if (path.startsWith(huggingFaceEpisodeShardPrefix)) {
        throw new Error("The Hugging Face episode shard path is not canonical");
      }
      return [];
    }
    if (seenEpisodeIndices.has(index)) {
      throw new Error("The Hugging Face repository contains duplicate episode shards");
    }
    seenEpisodeIndices.add(index);
    return [index];
  });
  if (input.repositoryRevision === null && episodeIndices.length > 0) {
    throw new Error("Hugging Face shards cannot exist without a repository revision");
  }
  if (episodeIndices.length === 0) {
    return {
      nextEpisodeIndex: 0,
      nextGlobalFrameIndex: 0,
      repositoryRevision: input.repositoryRevision,
    };
  }
  const latestEpisodeIndex = episodeIndices.reduce(
    (maximum, episodeIndex) => Math.max(maximum, episodeIndex),
    0,
  );
  if (!Number.isSafeInteger(latestEpisodeIndex + 1)) {
    throw new Error("The Hugging Face episode index is too large to append safely");
  }
  if (input.latestTotalEpisodes !== latestEpisodeIndex + 1) {
    throw new Error("The latest Hugging Face shard has invalid episode accounting");
  }
  if (
    !Number.isSafeInteger(input.latestTotalFrames)
    || (input.latestTotalFrames as number) <= 0
    || (input.latestTotalFrames as number) < latestEpisodeIndex + 1
  ) {
    throw new Error("The latest Hugging Face shard has invalid frame accounting");
  }
  return {
    nextEpisodeIndex: latestEpisodeIndex + 1,
    nextGlobalFrameIndex: input.latestTotalFrames as number,
    repositoryRevision: input.repositoryRevision,
  };
}


export function huggingFaceNextLinkTarget(link: string | null): string | null {
  if (!link) return null;
  if (/[\r\n]/.test(link)) throw new Error("The Hugging Face Link header is invalid");

  const segments: string[] = [];
  let segmentStart = 0;
  let inTarget = false;
  let inQuotedString = false;
  let quotedPair = false;
  for (let index = 0; index < link.length; index += 1) {
    const character = link[index];
    if (inTarget) {
      if (character === "<") throw new Error("The Hugging Face Link header is invalid");
      if (character === ">") inTarget = false;
      continue;
    }
    if (inQuotedString) {
      if (quotedPair) {
        quotedPair = false;
      } else if (character === "\\") {
        quotedPair = true;
      } else if (character === "\"") {
        inQuotedString = false;
      }
      continue;
    }
    if (character === "<") {
      inTarget = true;
    } else if (character === ">") {
      throw new Error("The Hugging Face Link header is invalid");
    } else if (character === "\"") {
      inQuotedString = true;
    } else if (character === ",") {
      const segment = link.slice(segmentStart, index).trim();
      if (!segment) throw new Error("The Hugging Face Link header is invalid");
      segments.push(segment);
      segmentStart = index + 1;
    }
  }
  if (inTarget || inQuotedString || quotedPair) {
    throw new Error("The Hugging Face Link header is invalid");
  }
  const finalSegment = link.slice(segmentStart).trim();
  if (!finalSegment) throw new Error("The Hugging Face Link header is invalid");
  segments.push(finalSegment);

  let nextTarget: string | null = null;
  for (const segment of segments) {
    const linkValue = /^<([^<>\s]+)>([\s\S]*)$/.exec(segment);
    if (!linkValue) throw new Error("The Hugging Face Link header is invalid");
    const relations: string[] = [];
    const parameters = linkValue[2];
    let cursor = 0;
    while (cursor < parameters.length) {
      while (parameters[cursor] === " " || parameters[cursor] === "\t") cursor += 1;
      if (cursor === parameters.length) break;
      if (parameters[cursor] !== ";") {
        throw new Error("The Hugging Face Link header is invalid");
      }
      cursor += 1;
      while (parameters[cursor] === " " || parameters[cursor] === "\t") cursor += 1;
      const name = httpLinkParameterTokenPattern.exec(parameters.slice(cursor))?.[0];
      if (!name) throw new Error("The Hugging Face Link header is invalid");
      cursor += name.length;
      while (parameters[cursor] === " " || parameters[cursor] === "\t") cursor += 1;
      if (parameters[cursor] !== "=") {
        throw new Error("The Hugging Face Link header is invalid");
      }
      cursor += 1;
      while (parameters[cursor] === " " || parameters[cursor] === "\t") cursor += 1;

      let value = "";
      if (parameters[cursor] === "\"") {
        cursor += 1;
        let closed = false;
        while (cursor < parameters.length) {
          const character = parameters[cursor];
          if (character === "\\") {
            cursor += 1;
            if (cursor === parameters.length) {
              throw new Error("The Hugging Face Link header is invalid");
            }
            value += parameters[cursor];
            cursor += 1;
          } else if (character === "\"") {
            cursor += 1;
            closed = true;
            break;
          } else {
            value += character;
            cursor += 1;
          }
        }
        if (!closed) throw new Error("The Hugging Face Link header is invalid");
      } else {
        const token = httpLinkParameterTokenPattern.exec(parameters.slice(cursor))?.[0];
        if (!token) throw new Error("The Hugging Face Link header is invalid");
        value = token;
        cursor += token.length;
      }
      if (name.toLowerCase() === "rel") {
        const parsedRelations = value.split(/[ \t]+/).filter(Boolean);
        if (parsedRelations.length === 0) {
          throw new Error("The Hugging Face Link header is invalid");
        }
        relations.push(...parsedRelations);
      }
    }
    if (!relations.some((relation) => relation.toLowerCase() === "next")) continue;
    if (nextTarget !== null) throw new Error("The Hugging Face Link header is invalid");
    nextTarget = linkValue[1];
  }
  return nextTarget;
}


export function sameHuggingFaceAppendAllocation(
  left: HuggingFaceAppendAllocation,
  right: HuggingFaceAppendAllocation,
) {
  return left.nextEpisodeIndex === right.nextEpisodeIndex
    && left.nextGlobalFrameIndex === right.nextGlobalFrameIndex
    && left.repositoryRevision === right.repositoryRevision;
}


export function matchesRetainedHuggingFaceAppendAllocation(
  actual: HuggingFaceAppendAllocation,
  retained: HuggingFaceAppendAllocation,
) {
  if (retained.repositoryRevision !== null) {
    return sameHuggingFaceAppendAllocation(actual, retained);
  }
  return actual.repositoryRevision !== null
    && actual.nextEpisodeIndex === retained.nextEpisodeIndex
    && actual.nextGlobalFrameIndex === retained.nextGlobalFrameIndex;
}


export function isHuggingFaceAppendAllocation(
  value: unknown,
): value is HuggingFaceAppendAllocation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<HuggingFaceAppendAllocation>;
  return Number.isSafeInteger(candidate.nextEpisodeIndex)
    && candidate.nextEpisodeIndex! >= 0
    && Number.isSafeInteger(candidate.nextGlobalFrameIndex)
    && candidate.nextGlobalFrameIndex! >= 0
    && (
      (
        candidate.repositoryRevision === null
        && candidate.nextEpisodeIndex === 0
        && candidate.nextGlobalFrameIndex === 0
      )
      || (
        typeof candidate.repositoryRevision === "string"
        && huggingFaceRepositoryRevisionPattern.test(candidate.repositoryRevision)
      )
    );
}


export interface AccountUploadManifestArtefact {
  path: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
}


export function accountUploadRequiresDirectUpload(
  artefact: AccountUploadManifestArtefact,
) {
  return artefact.byteLength > ACCOUNT_EXPORT_MAX_REGULAR_ARTEFACT_BYTES
    || artefact.mediaType === "video/mp4"
    || artefact.mediaType === "application/vnd.apache.parquet"
    || artefact.path.toLowerCase().endsWith(".parquet")
    || artefact.path.toLowerCase().endsWith(".mp4");
}


export type AccountUploadJobStatus =
  | "pending"
  | "preparing"
  | "uploading"
  | "finalising"
  | "completed"
  | "failed"
  | "cancelled";


export type AccountUploadArtefactStatus =
  | "pending"
  | "action_issued"
  | "uploaded"
  | "verified"
  | "failed";


export interface AccountUploadArtefactProgress extends AccountUploadManifestArtefact {
  status: AccountUploadArtefactStatus;
  retryCount: number;
  uploadedAt: string | null;
  verifiedAt: string | null;
}


export interface AccountUploadJob {
  version: typeof ACCOUNT_EXPORT_API_VERSION;
  id: string;
  accountSubject?: string;
  huggingFaceSubject?: string;
  captureSessionId: string;
  repository: string;
  branch: string;
  appendAllocation: HuggingFaceAppendAllocation;
  visibility: "private" | "public";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  episodeIds: string[];
  manifestHash: string;
  status: AccountUploadJobStatus;
  artefacts: AccountUploadArtefactProgress[];
  error: string | null;
  finalCommit: {
    oid: string;
    url: string;
    verifiedAt: string;
  } | null;
  completionReceipt: string | null;
  finalisationLeaseExpiresAt: string | null;
  finalisationReclaimable?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}


export interface AccountUploadCreateRequest {
  expectedAccountSubject?: string;
  expectedHuggingFaceSubject?: string;
  captureSessionId: string;
  repository: string;
  branch?: string;
  appendAllocation: HuggingFaceAppendAllocation;
  visibility: "private" | "public";
  missingRepositoryBehaviour?: HuggingFaceMissingRepositoryBehaviour;
  episodeIds: string[];
  artefacts: AccountUploadManifestArtefact[];
}


export interface AccountUploadCreateResponse {
  job: AccountUploadJob;
  resumed: boolean;
}


export interface AccountUploadPrepareRequest {
  artefactPaths?: string[];
}


export interface AccountDirectUploadAction {
  artefactPath: string;
  sha256: string;
  byteLength: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}


export interface AccountUploadPrepareResponse {
  job: AccountUploadJob;
  actions: AccountDirectUploadAction[];
}


export interface AccountUploadedArtefact {
  path: string;
  sha256: string;
  byteLength: number;
}


export interface AccountRegularUploadArtefact extends AccountUploadedArtefact {
  contentBase64: string;
}


export interface AccountUploadFinaliseRequest {
  uploadedArtefacts: AccountUploadedArtefact[];
  regularArtefacts: AccountRegularUploadArtefact[];
}


export interface AccountUploadFinaliseResponse {
  job: AccountUploadJob;
}


export interface AccountUploadCancelResponse {
  job: AccountUploadJob;
}