import { listDatasets, whoAmI } from "@huggingface/hub";
import type { SoloHuggingFaceCredential } from "./solo-hf-oauth.js";
import { soloHuggingFaceRepositoryName } from "./solo-hf-destination.js";

const fetchWithSignal = (signal: AbortSignal): typeof fetch => (
  input,
  init,
) => fetch(input, { ...init, signal });

export async function loadSoloHuggingFaceOwners(
  credential: SoloHuggingFaceCredential,
  signal: AbortSignal,
) {
  const profile = await whoAmI({
    accessToken: credential.accessToken,
    fetch: fetchWithSignal(signal),
  });
  signal.throwIfAborted();
  const owners = profile.type === "user"
    ? [profile.name, ...profile.orgs.map(({ name }) => name)]
    : [profile.name];
  return [...new Set(owners.filter((owner) => owner.trim().length > 0))];
}

export async function loadSoloHuggingFaceRepositories(
  credential: SoloHuggingFaceCredential,
  owner: string,
  query: string,
  signal: AbortSignal,
) {
  const repositories: string[] = [];
  for await (const dataset of listDatasets({
    accessToken: credential.accessToken,
    search: {
      owner,
      ...(query ? { query } : {}),
    },
    limit: 100,
    fetch: fetchWithSignal(signal),
  })) {
    signal.throwIfAborted();
    const name = soloHuggingFaceRepositoryName(dataset.id.startsWith(`${owner}/`)
      ? dataset.id.slice(owner.length + 1)
      : dataset.name);
    if (name) repositories.push(name);
  }
  return [...new Set(repositories)].sort((left, right) => left.localeCompare(right));
}
