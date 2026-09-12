import {
  HUGGING_FACE_REPOSITORY_ACCESS_VERSION,
  huggingFaceTokenScopeAllowsRepositoryAccess,
} from "../shared/export-destination.js";

const HUGGING_FACE_ORIGIN = "https://huggingface.co";
const OAUTH_STATE_KEY = "ceres.solo.hf-oauth.v1";
const OAUTH_ROUTE_HINT_KEY = "ceres.solo.hf-oauth-route.v1";
const STORAGE_ROOT = "ceres-solo-private";
const OAUTH_TRANSACTION_FILE = "oauth-transaction.json";
const OAUTH_TRANSACTION_TTL_MS = 10 * 60_000;
const SOLO_HUGGING_FACE_OAUTH_TIMEOUT_MS = 8_000;
const SOLO_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export interface SoloHuggingFaceCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  username: string;
  repositoryAccessVersion: number;
}

export type SoloHuggingFaceCredentialRefresh =
  | { status: "refreshed"; credential: SoloHuggingFaceCredential }
  | { status: "invalid" }
  | { status: "transient" };

interface PendingOauth {
  state: string;
  verifier: string;
  returnTo: string;
  createdAt?: string;
}

interface PendingOauthRouteHint extends PendingOauth {
  state: string;
  sessionId: string | null;
  createdAt: string;
}

export async function withSoloHuggingFaceOauthDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = SOLO_HUGGING_FACE_OAUTH_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(() => {
      const error = new DOMException("Hugging Face authorisation timed out", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout !== null) globalThis.clearTimeout(timeout);
  }
}

export async function restoreSoloHuggingFaceOauthReturnRoute() {
  const current = new URL(location.href);
  const state = current.searchParams.get("state");
  if (!state) return false;
  const routeHint = readPendingOauthRouteHint();
  if (routeHint && timingSafeEqual(state, routeHint.state)) {
    applySoloHuggingFaceOauthReturnRoute(current, routeHint.sessionId);
    return true;
  }
  let pending: PendingOauth | null;
  try {
    pending = await withSoloHuggingFaceOauthDeadline(async (signal) => {
      const value = await readPendingOauth();
      signal.throwIfAborted();
      return value;
    });
  } catch {
    replaceSoloHuggingFaceOauthCallbackUrl(current, current);
    return false;
  }
  if (!pending || !timingSafeEqual(state, pending.state)) return false;
  const returnTo = safeSoloReturnUrl(pending.returnTo, current.origin);
  if (!returnTo) return false;
  applySoloHuggingFaceOauthReturnRoute(current, returnTo.searchParams.get("session"));
  return true;
}

export async function beginSoloHuggingFaceOauth(
  returnTo = location.href,
  timeoutMs = SOLO_HUGGING_FACE_OAUTH_TIMEOUT_MS,
) {
  const origin = location.origin;
  const redirectUri = `${origin}/launch/capture/?mode=solo`;
  const validatedReturnTo = safeSoloReturnUrl(returnTo, origin);
  if (!validatedReturnTo) throw new Error("The Solo Hugging Face return route is invalid");
  const state = randomUrlValue(24);
  const verifier = randomUrlValue(48);
  const createdAt = new Date().toISOString();
  const pending = {
    state,
    verifier,
    returnTo: validatedReturnTo.href,
    createdAt,
  };
  const routeHintStored = savePendingOauthRouteHint({
    ...pending,
    sessionId: validatedReturnTo.searchParams.get("session"),
  });
  if (!routeHintStored) {
    await withSoloHuggingFaceOauthDeadline(async (signal) => {
      await savePendingOauth(pending);
      signal.throwIfAborted();
    }, timeoutMs);
  }
  const authorisation = new URL("/oauth/authorize", HUGGING_FACE_ORIGIN);
  authorisation.searchParams.set("client_id", `${origin}/.well-known/oauth-cimd`);
  authorisation.searchParams.set("redirect_uri", redirectUri);
  authorisation.searchParams.set("response_type", "code");
  authorisation.searchParams.set("scope", "openid profile write-repos contribute-repos");
  authorisation.searchParams.set("state", state);
  authorisation.searchParams.set("code_challenge", await pkceChallenge(verifier));
  authorisation.searchParams.set("code_challenge_method", "S256");
  location.assign(authorisation);
}

export async function completeSoloHuggingFaceOauth() {
  const current = new URL(location.href);
  const code = current.searchParams.get("code");
  const state = current.searchParams.get("state");
  if (!code && !state) return null;
  let returnTo = new URL(current);
  let transactionVerified = false;
  let transactionUsesRouteHint = false;
  try {
    return await withSoloHuggingFaceOauthDeadline(async (signal) => {
      const routeHint = readPendingOauthRouteHint();
      const pending = routeHint
        ? {
            state: routeHint.state,
            verifier: routeHint.verifier,
            returnTo: routeHint.returnTo,
            createdAt: routeHint.createdAt,
          }
        : await readPendingOauth();
      signal.throwIfAborted();
      if (!state || !pending || !timingSafeEqual(state, pending.state)) {
        throw new Error("Hugging Face authorisation could not be verified");
      }
      transactionUsesRouteHint = routeHint !== null;
      transactionVerified = true;
      const validatedReturnTo = safeSoloReturnUrl(pending.returnTo, current.origin);
      if (!validatedReturnTo) {
        throw new Error("The Solo Hugging Face return route is invalid");
      }
      returnTo = validatedReturnTo;
      if (!code || current.searchParams.has("error")) {
        throw new Error("Hugging Face authorisation was not completed");
      }
      const redirectUri = `${current.origin}/launch/capture/?mode=solo`;
      const response = await fetch(`${HUGGING_FACE_ORIGIN}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: `${current.origin}/.well-known/oauth-cimd`,
          redirect_uri: redirectUri,
          code,
          code_verifier: pending.verifier,
        }),
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Hugging Face authorisation failed");
      const token = await response.json() as {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
      };
      if (!huggingFaceTokenScopeAllowsRepositoryAccess(token.scope)) {
        throw new Error("Hugging Face repository access was not granted");
      }
      if (typeof token.access_token !== "string" || token.access_token.length < 16) {
        throw new Error("Hugging Face did not issue an access token");
      }
      const accessToken = token.access_token;
      const identity = await fetch(`${HUGGING_FACE_ORIGIN}/oauth/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal,
      });
      if (!identity.ok) throw new Error("Hugging Face credential validation failed");
      const profile = await identity.json() as { name?: unknown; preferred_username?: unknown };
      const username = typeof profile.preferred_username === "string"
        ? profile.preferred_username
        : typeof profile.name === "string" ? profile.name : "Hugging Face account";
      const expiresIn = typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
        ? token.expires_in
        : null;
      const credential: SoloHuggingFaceCredential = {
        accessToken,
        refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : null,
        expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1_000).toISOString(),
        username,
        repositoryAccessVersion: HUGGING_FACE_REPOSITORY_ACCESS_VERSION,
      };
      await saveSoloHuggingFaceCredential(credential);
      signal.throwIfAborted();
      if (transactionUsesRouteHint) {
        void clearSoloHuggingFaceOauthCallbackState(
          current,
          returnTo,
          clearPendingOauthRouteState,
        ).catch(() => undefined);
      } else {
        await clearSoloHuggingFaceOauthCallbackState(current, returnTo);
        signal.throwIfAborted();
      }
      return credential;
    });
  } catch (error) {
    if (transactionVerified) {
      try {
        await withSoloHuggingFaceOauthDeadline(
          () => clearSoloHuggingFaceOauthCallbackState(
            current,
            returnTo,
            transactionUsesRouteHint ? clearPendingOauthRouteState : clearPendingOauth,
          ),
          1_000,
        );
      } catch {
        // Preserve the authorisation failure after the callback URL has been sanitised.
      }
    } else {
      replaceSoloHuggingFaceOauthCallbackUrl(current, current);
    }
    throw error;
  }
}

export async function clearSoloHuggingFaceOauthCallbackState(
  current: URL,
  returnTo: URL,
  clearTransaction: () => Promise<void> = clearPendingOauth,
  replaceUrl: (url: URL) => void = (url) => history.replaceState(null, "", url),
) {
  replaceSoloHuggingFaceOauthCallbackUrl(current, returnTo, replaceUrl);
  clearPendingOauthRouteHint();
  let clearError: unknown = null;
  try {
    await clearTransaction();
  } catch (error) {
    clearError = error;
  }
  if (clearError) throw clearError;
}

function replaceSoloHuggingFaceOauthCallbackUrl(
  current: URL,
  returnTo: URL,
  replaceUrl: (url: URL) => void = (url) => history.replaceState(null, "", url),
) {
  const sanitisedReturnTo = returnTo.origin === current.origin
    ? new URL(returnTo)
    : new URL(current);
  sanitisedReturnTo.searchParams.delete("code");
  sanitisedReturnTo.searchParams.delete("state");
  sanitisedReturnTo.searchParams.delete("error");
  replaceUrl(sanitisedReturnTo);
}

export async function refreshSoloHuggingFaceCredential(
  credential: SoloHuggingFaceCredential,
  signal: AbortSignal,
): Promise<SoloHuggingFaceCredentialRefresh> {
  const refreshToken = credential.refreshToken;
  if (!refreshToken || refreshToken !== refreshToken.trim()) return { status: "invalid" };
  let response: Response;
  try {
    response = await fetch(`${HUGGING_FACE_ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: `${location.origin}/.well-known/oauth-cimd`,
        refresh_token: refreshToken,
      }),
      cache: "no-store",
      signal,
    });
  } catch {
    return { status: "transient" };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { status: "invalid" };
  }
  if (!response.ok) return { status: "transient" };
  let token: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  try {
    token = await response.json() as typeof token;
  } catch {
    return { status: "transient" };
  }
  if (!huggingFaceTokenScopeAllowsRepositoryAccess(token.scope)) return { status: "invalid" };
  if (
    typeof token.access_token !== "string"
    || !token.access_token.startsWith("hf_")
    || token.access_token.length < 16
  ) return { status: "transient" };
  const expiresIn = typeof token.expires_in === "number" && Number.isFinite(token.expires_in)
    ? token.expires_in
    : null;
  const refreshed: SoloHuggingFaceCredential = {
    ...credential,
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === "string"
      ? token.refresh_token
      : refreshToken,
    expiresAt: expiresIn === null
      ? null
      : new Date(Date.now() + expiresIn * 1_000).toISOString(),
  };
  try {
    await saveSoloHuggingFaceCredential(refreshed);
  } catch {
    return { status: "transient" };
  }
  return { status: "refreshed", credential: refreshed };
}

export async function loadSoloHuggingFaceCredential(
  timeoutMs = SOLO_HUGGING_FACE_OAUTH_TIMEOUT_MS,
): Promise<SoloHuggingFaceCredential | null> {
  try {
    return await withSoloHuggingFaceOauthDeadline(async (signal) => {
      const root = await credentialDirectory(false);
      signal.throwIfAborted();
      if (!root) return null;
      const handle = await root.getFileHandle("credential.json");
      signal.throwIfAborted();
      const file = await handle.getFile();
      signal.throwIfAborted();
      const value = JSON.parse(await file.text()) as Partial<SoloHuggingFaceCredential>;
      signal.throwIfAborted();
      return typeof value.accessToken === "string" && typeof value.username === "string"
        ? {
            accessToken: value.accessToken,
            refreshToken: typeof value.refreshToken === "string" ? value.refreshToken : null,
            expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : null,
            username: value.username,
            repositoryAccessVersion: Number.isSafeInteger(value.repositoryAccessVersion)
              ? value.repositoryAccessVersion as number
              : 0,
          }
        : null;
    }, timeoutMs);
  } catch {
    return null;
  }
}

export async function saveSoloHuggingFaceCredential(credential: SoloHuggingFaceCredential) {
  const root = await credentialDirectory(true);
  if (!root) throw new Error("Origin private storage is unavailable");
  const handle = await root.getFileHandle("credential.json", { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(credential));
  await writable.close();
}

export async function deleteSoloHuggingFaceCredential() {
  try {
    const root = await credentialDirectory(false);
    if (!root) return;
    await root.removeEntry("credential.json");
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

async function readPendingOauth(): Promise<PendingOauth | null> {
  const hinted = readPendingOauthRouteHint();
  if (hinted) {
    return {
      state: hinted.state,
      verifier: hinted.verifier,
      returnTo: hinted.returnTo,
      createdAt: hinted.createdAt,
    };
  }
  const stored = await readPendingOauthFromOpfs();
  if (stored) return stored;
  try {
    const value = JSON.parse(sessionStorage.getItem(OAUTH_STATE_KEY) ?? "null") as Partial<PendingOauth> | null;
    return validPendingOauth(value);
  } catch {
    return null;
  }
}

async function readPendingOauthFromOpfs() {
  try {
    const root = await credentialDirectory(false);
    if (!root) return null;
    const handle = await root.getFileHandle(OAUTH_TRANSACTION_FILE);
    const value = JSON.parse(await (await handle.getFile()).text()) as Partial<PendingOauth> | null;
    const pending = validPendingOauth(value);
    if (!pending) return null;
    const createdAt = pending.createdAt ? Date.parse(pending.createdAt) : Number.NaN;
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > OAUTH_TRANSACTION_TTL_MS) {
      await clearPendingOauth();
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function validPendingOauth(value: Partial<PendingOauth> | null): PendingOauth | null {
  return value
    && typeof value.state === "string"
    && typeof value.verifier === "string"
    && typeof value.returnTo === "string"
    && (value.createdAt === undefined || typeof value.createdAt === "string")
    ? {
        state: value.state,
        verifier: value.verifier,
        returnTo: value.returnTo,
        ...(value.createdAt ? { createdAt: value.createdAt } : {}),
      }
    : null;
}

async function savePendingOauth(pending: PendingOauth) {
  const root = await credentialDirectory(true);
  if (!root) throw new Error("Origin private storage is unavailable");
  const handle = await root.getFileHandle(OAUTH_TRANSACTION_FILE, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(pending));
  await writable.close();
}

async function clearPendingOauth() {
  clearPendingOauthRouteHint();
  clearLegacyPendingOauth();
  try {
    const root = await credentialDirectory(false);
    if (!root) return;
    await root.removeEntry(OAUTH_TRANSACTION_FILE);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return;
    throw error;
  }
}

function applySoloHuggingFaceOauthReturnRoute(current: URL, sessionId: string | null) {
  current.searchParams.set("mode", "solo");
  if (sessionId) current.searchParams.set("session", sessionId);
  else current.searchParams.delete("session");
  history.replaceState(null, "", current);
}

function readPendingOauthRouteHint(): PendingOauthRouteHint | null {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(OAUTH_ROUTE_HINT_KEY) ?? "null") as
      Partial<PendingOauthRouteHint> | null;
    const createdAtMs = typeof value?.createdAt === "string"
      ? Date.parse(value.createdAt)
      : Number.NaN;
    const ageMs = Date.now() - createdAtMs;
    if (
      !value
      || typeof value.state !== "string"
      || value.state.length === 0
      || value.state.length > 512
      || typeof value.verifier !== "string"
      || !/^[A-Za-z0-9_-]{43,128}$/.test(value.verifier)
      || typeof value.returnTo !== "string"
      || value.returnTo.length > 2_048
      || (value.sessionId !== null && (
        typeof value.sessionId !== "string"
        || !SOLO_SESSION_ID_PATTERN.test(value.sessionId)
      ))
      || !Number.isFinite(createdAtMs)
      || ageMs < -60_000
      || ageMs > OAUTH_TRANSACTION_TTL_MS
    ) {
      clearPendingOauthRouteHint();
      return null;
    }
    return {
      state: value.state,
      verifier: value.verifier,
      returnTo: value.returnTo,
      sessionId: value.sessionId,
      createdAt: value.createdAt!,
    };
  } catch {
    clearPendingOauthRouteHint();
    return null;
  }
}

function savePendingOauthRouteHint(hint: PendingOauthRouteHint) {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(OAUTH_ROUTE_HINT_KEY, JSON.stringify(hint));
    return storage.getItem(OAUTH_ROUTE_HINT_KEY) !== null;
  } catch {
    return false;
  }
}

async function clearPendingOauthRouteState() {
  clearPendingOauthRouteHint();
  clearLegacyPendingOauth();
}

function clearLegacyPendingOauth() {
  try {
    globalThis.sessionStorage?.removeItem(OAUTH_STATE_KEY);
  } catch {
    // The authoritative local or OPFS transaction has already been cleared.
  }
}

function clearPendingOauthRouteHint() {
  try {
    globalThis.localStorage?.removeItem(OAUTH_ROUTE_HINT_KEY);
  } catch {
    // The OAuth transaction can still be cleared from OPFS.
  }
}

function safeSoloReturnUrl(value: string, origin: string) {
  try {
    const returnTo = new URL(value, origin);
    if (
      returnTo.origin !== origin
      || returnTo.pathname !== "/launch/capture/"
      || returnTo.searchParams.get("mode") !== "solo"
    ) return null;
    const sessionIds = returnTo.searchParams.getAll("session");
    if (
      sessionIds.length > 1
      || (sessionIds.length === 1 && !SOLO_SESSION_ID_PATTERN.test(sessionIds[0]!))
    ) return null;
    return returnTo;
  } catch {
    return null;
  }
}

async function credentialDirectory(create: boolean) {
  if (!navigator.storage?.getDirectory) throw new Error("Origin private storage is unavailable");
  const root = await navigator.storage.getDirectory();
  try {
    const privateRoot = await root.getDirectoryHandle(STORAGE_ROOT, { create });
    return await privateRoot.getDirectoryHandle("hugging-face", { create });
  } catch (error) {
    if (!create && error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

function randomUrlValue(bytes: number) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

async function pkceChallenge(verifier: string) {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
