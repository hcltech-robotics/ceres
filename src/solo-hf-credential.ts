import { HubApiError, whoAmI } from "@huggingface/hub";
import { HUGGING_FACE_REPOSITORY_ACCESS_VERSION } from "../shared/export-destination.js";
import {
  refreshSoloHuggingFaceCredential,
  type SoloHuggingFaceCredential,
  type SoloHuggingFaceCredentialRefresh,
} from "./solo-hf-oauth.js";

type SoloHuggingFaceCredentialProbe = (
  accessToken: string,
  signal: AbortSignal,
) => Promise<unknown>;

type SoloHuggingFaceCredentialRefresher = (
  credential: SoloHuggingFaceCredential,
  signal: AbortSignal,
) => Promise<SoloHuggingFaceCredentialRefresh>;

export type SoloHuggingFaceCredentialVerification =
  | { status: "valid"; subject: string; credential: SoloHuggingFaceCredential }
  | { status: "invalid"; reason: "expired" | "rejected" | "scope" }
  | { status: "transient" };

const probeSoloHuggingFaceCredential: SoloHuggingFaceCredentialProbe = async (
  accessToken,
  signal,
) => {
  return whoAmI({
    accessToken,
    fetch: (input, init) => fetch(input, { ...init, signal }),
  });
};

const SOLO_HUGGING_FACE_CREDENTIAL_TIMEOUT_MS = 8_000;

function waitForCredentialProbe<T>(
  probe: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const finish = (callback: () => void) => {
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    probe.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export async function verifySoloHuggingFaceCredential(
  credential: SoloHuggingFaceCredential,
  probe: SoloHuggingFaceCredentialProbe = probeSoloHuggingFaceCredential,
  options: {
    timeoutMs?: number;
    refresh?: SoloHuggingFaceCredentialRefresher;
  } = {},
): Promise<SoloHuggingFaceCredentialVerification> {
  if (credential.repositoryAccessVersion !== HUGGING_FACE_REPOSITORY_ACCESS_VERSION) {
    return { status: "invalid", reason: "scope" };
  }
  if (!credential.accessToken.startsWith("hf_") || credential.accessToken.length < 16) {
    return { status: "invalid", reason: "rejected" };
  }
  const expiresAt = credential.expiresAt === null
    ? null
    : Date.parse(credential.expiresAt);
  const abort = new AbortController();
  const timeout = globalThis.setTimeout(() => {
    abort.abort(new DOMException("Hugging Face credential verification timed out", "TimeoutError"));
  }, options.timeoutMs ?? SOLO_HUGGING_FACE_CREDENTIAL_TIMEOUT_MS);
  try {
    let verifiedCredential = credential;
    if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      if (!credential.refreshToken) return { status: "invalid", reason: "expired" };
      const refreshed = await waitForCredentialProbe(
        (options.refresh ?? refreshSoloHuggingFaceCredential)(credential, abort.signal),
        abort.signal,
      );
      if (refreshed.status === "invalid") return { status: "invalid", reason: "rejected" };
      if (refreshed.status === "transient") return { status: "transient" };
      verifiedCredential = refreshed.credential;
    }
    const identity = await waitForCredentialProbe(
      probe(verifiedCredential.accessToken, abort.signal),
      abort.signal,
    );
    const subject = identity && typeof identity === "object"
      ? (identity as { id?: unknown }).id
      : null;
    if (
      typeof subject !== "string"
      || subject.length === 0
      || subject.length > 256
      || subject !== subject.trim()
    ) {
      return { status: "transient" };
    }
    return { status: "valid", subject, credential: verifiedCredential };
  } catch (error) {
    if (error instanceof HubApiError && (error.statusCode === 401 || error.statusCode === 403)) {
      return { status: "invalid", reason: "rejected" };
    }
    return { status: "transient" };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}
