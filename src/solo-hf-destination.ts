import type {
  AccountExportDestinationValidation,
  AccountExportDestinationValidationRequest,
  HuggingFaceAppendAllocation,
} from "../shared/export-destination.js";
import {
  huggingFaceAppendAllocation,
  huggingFaceEpisodeShardIndex,
  huggingFaceNextLinkTarget,
  huggingFaceOrganisationRoleCanCreateRepositories,
} from "../shared/export-destination.js";
import type { SoloHuggingFaceCredential } from "./solo-hf-oauth.js";

const segmentPattern = /^[A-Za-z0-9._-]{1,96}$/;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const repositoryRevisionPattern = /^[a-f0-9]{40,64}$/;
const maximumTreePages = 100;

export type SoloHuggingFaceDestinationErrorCode =
  | "authentication"
  | "permission"
  | "not-found"
  | "naming"
  | "request";

export class SoloHuggingFaceDestinationError extends Error {
  constructor(
    readonly code: SoloHuggingFaceDestinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SoloHuggingFaceDestinationError";
  }
}

export function soloHuggingFaceRepositoryName(value: string) {
  const candidate = value.trim();
  const separator = candidate.lastIndexOf("/");
  return separator >= 0 ? candidate.slice(separator + 1).trim() : candidate;
}

export function normaliseSoloHuggingFaceDestination(
  value: AccountExportDestinationValidationRequest,
): AccountExportDestinationValidationRequest & { resolved: string } {
  const organisation = value.organisation.trim();
  const repository = value.repository.trim();
  if (!validRepositorySegment(organisation)) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Choose a valid Hugging Face namespace",
    );
  }
  if (!validRepositorySegment(repository)) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Enter a valid Hugging Face repository name",
    );
  }
  const branch = typeof value.branch === "string" ? value.branch.trim() : "";
  if (!validBranch(branch)) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Enter a valid Hugging Face branch",
    );
  }
  if (value.visibility !== "private" && value.visibility !== "public") {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Choose a valid Hugging Face repository visibility",
    );
  }
  if (
    value.missingRepositoryBehaviour !== "do-not-create"
    && value.missingRepositoryBehaviour !== "private"
    && value.missingRepositoryBehaviour !== "public"
  ) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Choose how Solo should handle a missing repository",
    );
  }
  if (
    value.missingRepositoryBehaviour !== "do-not-create"
    && value.missingRepositoryBehaviour !== value.visibility
  ) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "The missing repository visibility must match the reviewed visibility",
    );
  }
  return {
    organisation,
    repository,
    branch,
    visibility: value.visibility,
    missingRepositoryBehaviour: value.missingRepositoryBehaviour,
    resolved: `${organisation}/${repository}`,
  };
}

export async function validateSoloHuggingFaceDestination(
  credential: SoloHuggingFaceCredential,
  availableOrganisations: ReadonlySet<string>,
  value: AccountExportDestinationValidationRequest,
  signal: AbortSignal,
  fetchImplementation: typeof fetch = fetch,
): Promise<AccountExportDestinationValidation> {
  const normalised = normaliseSoloHuggingFaceDestination(value);
  const organisation = [...availableOrganisations].find(
    (candidate) => candidate.toLowerCase() === normalised.organisation.toLowerCase(),
  );
  if (!organisation) {
    throw new SoloHuggingFaceDestinationError(
      "permission",
      "The connected Hugging Face account cannot use this namespace",
    );
  }
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetchImplementation(
      `https://huggingface.co/api/datasets/${organisation}/${normalised.repository}`,
      {
        headers: { Authorization: `Bearer ${credential.accessToken}` },
        cache: "no-store",
        signal,
      },
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face could not verify this destination. Try again.",
    );
  }
  signal.throwIfAborted();
  const resolved = `${organisation}/${normalised.repository}`;
  if (response.ok) {
    let metadata: { private?: unknown };
    try {
      metadata = await response.json() as { private?: unknown };
    } catch {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned invalid repository information",
      );
    }
    if (typeof metadata.private !== "boolean") {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned invalid repository information",
      );
    }
    const visibility = metadata.private ? "private" : "public";
    if (visibility !== normalised.visibility) {
      throw new SoloHuggingFaceDestinationError(
        "permission",
        "The existing Hugging Face repository visibility does not match the reviewed destination",
      );
    }
    const permission = await destinationFetch(
      fetchImplementation,
      `https://huggingface.co/api/datasets/${resolved}/preupload/${encodeURIComponent(normalised.branch)}`,
      credential.accessToken,
      signal,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: [{ path: ".ceres-write-probe", sample: "", size: 0 }],
        }),
      },
    );
    throwForDestinationResponse(permission);
    const append = await inspectSoloHuggingFaceAppendAllocation({
      repository: resolved,
      branch: normalised.branch,
      accessToken: credential.accessToken,
      signal,
      fetchImplementation,
    });
    return {
      version: 1,
      repository: resolved,
      branch: normalised.branch,
      availability: "existing",
      visibility,
      append,
    };
  }
  if (response.status === 401) {
    throw new SoloHuggingFaceDestinationError(
      "authentication",
      "Hugging Face authentication is required",
    );
  }
  if (response.status === 403) {
    throw new SoloHuggingFaceDestinationError(
      "permission",
      "The connected Hugging Face account cannot write to this repository",
    );
  }
  if (response.status === 400) {
    throw new SoloHuggingFaceDestinationError(
      "naming",
      "Hugging Face rejected this repository name",
    );
  }
  if (response.status !== 404) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face could not verify this destination. Try again.",
    );
  }
  if (normalised.missingRepositoryBehaviour === "do-not-create") {
    throw new SoloHuggingFaceDestinationError(
      "not-found",
      "The Hugging Face dataset repository was not found",
    );
  }
  if (!await canCreateInNamespace(
    credential,
    organisation,
    signal,
    fetchImplementation,
  )) {
    throw new SoloHuggingFaceDestinationError(
      "permission",
      "The connected Hugging Face account cannot create a repository in this namespace",
    );
  }
  return {
    version: 1,
    repository: resolved,
    branch: normalised.branch,
    availability: "creatable",
    visibility: normalised.missingRepositoryBehaviour,
    append: {
      nextEpisodeIndex: 0,
      nextGlobalFrameIndex: 0,
      repositoryRevision: null,
    },
  };
}

export async function inspectSoloHuggingFaceAppendAllocation(input: {
  repository: string;
  branch: string;
  accessToken: string;
  signal: AbortSignal;
  fetchImplementation?: typeof fetch;
}): Promise<HuggingFaceAppendAllocation> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const revisionResponse = await destinationFetch(
    fetchImplementation,
    `https://huggingface.co/api/datasets/${input.repository}/revision/${encodeURIComponent(input.branch)}`,
    input.accessToken,
    input.signal,
  );
  if (revisionResponse.status === 404) {
    throw new SoloHuggingFaceDestinationError(
      "not-found",
      "The selected Hugging Face branch was not found",
    );
  }
  throwForDestinationResponse(revisionResponse);
  let revisionValue: { sha?: unknown };
  try {
    revisionValue = await revisionResponse.json() as { sha?: unknown };
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid branch information",
    );
  }
  if (
    typeof revisionValue.sha !== "string"
    || !repositoryRevisionPattern.test(revisionValue.sha)
  ) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid branch information",
    );
  }
  const repositoryRevision = revisionValue.sha;
  await assertSoloHuggingFaceBranchReference({
    ...input,
    repositoryRevision,
    fetchImplementation,
  });
  const shardPaths = await listSoloHuggingFaceShardPaths({
    ...input,
    repositoryRevision,
    fetchImplementation,
  });
  const latestShardPath = shardPaths.reduce<string | null>((latest, path) => {
    const index = huggingFaceEpisodeShardIndex(path);
    if (index === null) return latest;
    if (latest === null) return path;
    return index > huggingFaceEpisodeShardIndex(latest)! ? path : latest;
  }, null);
  if (latestShardPath === null) {
    try {
      return huggingFaceAppendAllocation({ repositoryRevision, shardPaths });
    } catch {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned invalid episode shard accounting",
      );
    }
  }
  const infoResponse = await destinationFetch(
    fetchImplementation,
    `https://huggingface.co/datasets/${input.repository}/resolve/${repositoryRevision}/${latestShardPath}/meta/info.json`,
    input.accessToken,
    input.signal,
  );
  throwForDestinationResponse(infoResponse);
  let info: { total_frames?: unknown; total_episodes?: unknown };
  try {
    info = await infoResponse.json() as { total_frames?: unknown; total_episodes?: unknown };
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid LeRobot frame accounting",
    );
  }
  try {
    return huggingFaceAppendAllocation({
      repositoryRevision,
      shardPaths,
      latestTotalFrames: info.total_frames,
      latestTotalEpisodes: info.total_episodes,
    });
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid LeRobot frame accounting",
    );
  }
}

async function assertSoloHuggingFaceBranchReference(input: {
  repository: string;
  branch: string;
  repositoryRevision: string;
  accessToken: string;
  signal: AbortSignal;
  fetchImplementation: typeof fetch;
}) {
  const response = await destinationFetch(
    input.fetchImplementation,
    `https://huggingface.co/api/datasets/${input.repository}/refs`,
    input.accessToken,
    input.signal,
  );
  if (response.status === 404) {
    throw new SoloHuggingFaceDestinationError(
      "not-found",
      "The selected Hugging Face branch was not found",
    );
  }
  throwForDestinationResponse(response);
  let value: unknown;
  try {
    value = await response.json() as unknown;
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid branch references",
    );
  }
  const branches = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { branches?: unknown }).branches
    : undefined;
  if (!Array.isArray(branches)) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid branch references",
    );
  }
  const matches: Array<{ targetCommit: string }> = [];
  for (const entry of branches) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned invalid branch references",
      );
    }
    const branch = entry as { name?: unknown; ref?: unknown; targetCommit?: unknown };
    if (
      typeof branch.name !== "string"
      || typeof branch.ref !== "string"
      || typeof branch.targetCommit !== "string"
      || !repositoryRevisionPattern.test(branch.targetCommit)
    ) {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned invalid branch references",
      );
    }
    if (branch.name === input.branch && branch.ref === `refs/heads/${input.branch}`) {
      matches.push({ targetCommit: branch.targetCommit });
    }
  }
  if (matches.length === 0) {
    throw new SoloHuggingFaceDestinationError(
      "not-found",
      "The selected Hugging Face revision is not a branch",
    );
  }
  if (matches.length !== 1 || matches[0]!.targetCommit !== input.repositoryRevision) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "The selected Hugging Face branch changed while it was being inspected",
    );
  }
}

async function listSoloHuggingFaceShardPaths(input: {
  repository: string;
  branch: string;
  repositoryRevision: string;
  accessToken: string;
  signal: AbortSignal;
  fetchImplementation: typeof fetch;
}) {
  const endpoint = `https://huggingface.co/api/datasets/${input.repository}/tree/${input.repositoryRevision}/shards`;
  let url: string | null = `${endpoint}?recursive=false&expand=false`;
  const paths: string[] = [];
  for (let page = 0; url !== null && page < maximumTreePages; page += 1) {
    const response = await destinationFetch(
      input.fetchImplementation,
      url,
      input.accessToken,
      input.signal,
    );
    if (response.status === 404) {
      if (response.headers.get("X-Error-Code") !== "EntryNotFound") {
        throw new SoloHuggingFaceDestinationError(
          "request",
          "The Hugging Face repository tree could not be inspected at the pinned revision",
        );
      }
      await confirmSoloHuggingFaceBranchRevision(input);
      return [];
    }
    throwForDestinationResponse(response);
    let entries: unknown;
    try {
      entries = await response.json() as unknown;
    } catch {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned an invalid repository tree",
      );
    }
    if (!Array.isArray(entries)) {
      throw new SoloHuggingFaceDestinationError(
        "request",
        "Hugging Face returned an invalid repository tree",
      );
    }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new SoloHuggingFaceDestinationError(
          "request",
          "Hugging Face returned an invalid repository tree entry",
        );
      }
      const candidate = entry as { path?: unknown; type?: unknown };
      if (
        typeof candidate.path !== "string"
        || !candidate.path.startsWith("shards/")
        || candidate.path.includes("\\")
        || candidate.path.split("/").some((segment) => segment === "." || segment === "..")
        || (candidate.type !== "directory" && candidate.type !== "file")
      ) {
        throw new SoloHuggingFaceDestinationError(
          "request",
          "Hugging Face returned an invalid repository tree entry",
        );
      }
      if (
        candidate.path.startsWith("shards/episode-")
        && candidate.type !== "directory"
      ) {
        throw new SoloHuggingFaceDestinationError(
          "request",
          "Hugging Face returned an invalid episode shard entry",
        );
      }
      paths.push(candidate.path);
    }
    url = nextHuggingFaceTreePage(response.headers.get("Link"), endpoint);
  }
  if (url !== null) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "The Hugging Face repository tree is too large to inspect safely",
    );
  }
  return paths;
}

async function confirmSoloHuggingFaceBranchRevision(input: {
  repository: string;
  branch: string;
  repositoryRevision: string;
  accessToken: string;
  signal: AbortSignal;
  fetchImplementation: typeof fetch;
}) {
  const response = await destinationFetch(
    input.fetchImplementation,
    `https://huggingface.co/api/datasets/${input.repository}/revision/${encodeURIComponent(input.branch)}`,
    input.accessToken,
    input.signal,
  );
  throwForDestinationResponse(response);
  let value: { sha?: unknown };
  try {
    value = await response.json() as { sha?: unknown };
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid branch information",
    );
  }
  if (value.sha !== input.repositoryRevision) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "The selected Hugging Face branch changed while it was being inspected",
    );
  }
  await assertSoloHuggingFaceBranchReference(input);
}

function nextHuggingFaceTreePage(link: string | null, endpoint: string) {
  let target: string | null;
  try {
    target = huggingFaceNextLinkTarget(link);
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned an invalid repository tree page",
    );
  }
  if (target === null) return null;
  let url: URL;
  try {
    url = new URL(target, "https://huggingface.co");
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned an invalid repository tree page",
    );
  }
  if (
    url.origin !== "https://huggingface.co"
    || url.username
    || url.password
    || (url.href !== endpoint && !url.href.startsWith(`${endpoint}?`))
  ) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned an invalid repository tree page",
    );
  }
  return url.toString();
}

async function destinationFetch(
  fetchImplementation: typeof fetch,
  url: string,
  accessToken: string,
  signal: AbortSignal,
  init: RequestInit = {},
) {
  try {
    return await fetchImplementation(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...Object.fromEntries(new Headers(init.headers)),
      },
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face could not verify this destination. Try again.",
    );
  }
}

function throwForDestinationResponse(response: Response) {
  if (response.ok) return;
  if (response.status === 401) {
    throw new SoloHuggingFaceDestinationError(
      "authentication",
      "Hugging Face authentication is required",
    );
  }
  if (response.status === 403) {
    throw new SoloHuggingFaceDestinationError(
      "permission",
      "The connected Hugging Face account cannot write to this repository",
    );
  }
  if (response.status === 404) {
    throw new SoloHuggingFaceDestinationError(
      "not-found",
      "The Hugging Face dataset repository was not found",
    );
  }
  throw new SoloHuggingFaceDestinationError(
    "request",
    "Hugging Face could not verify this destination. Try again.",
  );
}

async function canCreateInNamespace(
  credential: SoloHuggingFaceCredential,
  organisation: string,
  signal: AbortSignal,
  fetchImplementation: typeof fetch,
) {
  const identityResponse = await destinationFetch(
    fetchImplementation,
    "https://huggingface.co/oauth/userinfo",
    credential.accessToken,
    signal,
  );
  if (!identityResponse.ok) {
    if (identityResponse.status === 401 || identityResponse.status === 403) {
      throw new SoloHuggingFaceDestinationError(
        "authentication",
        "Hugging Face authentication is required",
      );
    }
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face could not verify this account. Try again.",
    );
  }
  let identity: {
    preferred_username?: unknown;
    orgs?: unknown;
  };
  try {
    identity = await identityResponse.json() as typeof identity;
  } catch {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid account information",
    );
  }
  const username = typeof identity.preferred_username === "string"
    ? identity.preferred_username
    : "";
  if (!username || username !== username.trim()) {
    throw new SoloHuggingFaceDestinationError(
      "request",
      "Hugging Face returned invalid account information",
    );
  }
  if (username.toLowerCase() === organisation.toLowerCase()) return true;
  if (!Array.isArray(identity.orgs)) return false;
  return identity.orgs.some((candidate) => {
    if (!candidate || typeof candidate !== "object") return false;
    const value = candidate as { preferred_username?: unknown; roleInOrg?: unknown };
    const name = typeof value.preferred_username === "string"
      ? value.preferred_username
      : "";
    return name.toLowerCase() === organisation.toLowerCase()
      && huggingFaceOrganisationRoleCanCreateRepositories(value.roleInOrg);
  });
}

export function soloHuggingFaceDestinationError(
  error: unknown,
): SoloHuggingFaceDestinationError {
  if (error instanceof SoloHuggingFaceDestinationError) return error;
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 401) {
      return new SoloHuggingFaceDestinationError(
        "authentication",
        "Hugging Face authentication is required",
      );
    }
    if (status === 403) {
      return new SoloHuggingFaceDestinationError(
        "permission",
        "The connected Hugging Face account cannot write to this repository",
      );
    }
    if (status === 404) {
      return new SoloHuggingFaceDestinationError(
        "not-found",
        "The Hugging Face dataset repository was not found",
      );
    }
    if (status === 400) {
      return new SoloHuggingFaceDestinationError(
        "naming",
        "Hugging Face rejected this repository name",
      );
    }
  }
  return new SoloHuggingFaceDestinationError(
    "request",
    "Hugging Face could not verify this destination. Try again.",
  );
}

function validRepositorySegment(value: string) {
  return segmentPattern.test(value)
    && !value.startsWith("-")
    && !value.startsWith(".")
    && !value.endsWith("-")
    && !value.endsWith(".")
    && !value.includes("--")
    && !value.includes("..")
    && !value.endsWith(".git");
}

function validBranch(value: string) {
  const components = value.split("/");
  return branchPattern.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock")
    && components.every((component) => (
      component.length > 0
      && !component.startsWith(".")
      && !component.endsWith(".")
      && !component.endsWith(".lock")
    ));
}
