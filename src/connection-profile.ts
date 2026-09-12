declare const __CERES_DEPLOYMENT_TARGET__: string;
declare const __CERES_RELAY_URL__: string;

export type ConnectionMode = "local" | "direct" | "relayed";

export interface ConnectionProfile {
  mode: ConnectionMode;
  relayUrl: string | null;
}

const applicationOrigin = typeof location === "undefined" ? "http://localhost:4317" : location.origin;
const defaultRelayCandidate = typeof __CERES_RELAY_URL__ === "string" && __CERES_RELAY_URL__
  ? __CERES_RELAY_URL__
  : applicationOrigin;
let configuredIceServers: RTCIceServer[] = [];

export function configureIceServers(servers: RTCIceServer[]) {
  configuredIceServers = structuredClone(servers);
}

function normaliseConnectionServerValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const localHttp = url.protocol === "http:"
      && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    url.pathname = "/";
    return url.toString();
  } catch {
    return null;
  }
}

function browserDeploymentTarget() {
  return typeof __CERES_DEPLOYMENT_TARGET__ === "string"
    ? __CERES_DEPLOYMENT_TARGET__
    : "download";
}

export const defaultCeresRelayUrl = normaliseConnectionServerValue(defaultRelayCandidate)
  ?? applicationOrigin;

export const defaultConnectionProfile: ConnectionProfile = {
  mode: "local",
  relayUrl: null,
};

export function normaliseConnectionServer(
  value: unknown,
  deploymentTarget = browserDeploymentTarget(),
  hostedRelayUrl = defaultCeresRelayUrl,
): string | null {
  const normalised = normaliseConnectionServerValue(value);
  if (!normalised) return null;
  if (deploymentTarget !== "vercel") return normalised;
  const configuredRelay = normaliseConnectionServerValue(hostedRelayUrl);
  return configuredRelay?.startsWith("https://") && normalised === configuredRelay
    ? normalised
    : null;
}

export function connectionProfileFromSearch(search = typeof location === "undefined" ? "" : location.search): ConnectionProfile {
  const parameters = new URLSearchParams(search);
  const mode = parameters.get("connection");
  if (mode !== "direct" && mode !== "relayed") return { ...defaultConnectionProfile };
  return {
    mode,
    relayUrl: normaliseConnectionServer(parameters.get("relay")) ?? defaultCeresRelayUrl,
  };
}

export function applyConnectionProfile(parameters: URLSearchParams, profile: ConnectionProfile) {
  parameters.delete("connection");
  parameters.delete("relay");
  parameters.delete("billing");
  parameters.delete("billingCode");
  if (profile.mode === "local") return;
  parameters.set("connection", profile.mode);
  parameters.set("relay", connectionServerUrl(profile));
}

export function connectionServerUrl(profile: ConnectionProfile) {
  return normaliseConnectionServer(profile.relayUrl) ?? defaultCeresRelayUrl;
}

export function isPeerConnectionMode(profile: ConnectionProfile) {
  return profile.mode === "local" || profile.mode === "direct" || profile.mode === "relayed";
}

export function sessionSocketBlocksMonitorFrame(profile: ConnectionProfile, bufferedAmount: number, limit: number) {
  return !isPeerConnectionMode(profile) && bufferedAmount > limit;
}

export function connectionModeLabel(mode: ConnectionMode) {
  return mode === "local" ? "Local only" : mode === "direct" ? "Direct" : "Relayed experimental";
}

export function connectionModeDescription(mode: ConnectionMode) {
  if (mode === "local") return "Uses an expiring QR invitation and host-network ICE candidates. The relay exchanges only pairing signals. Recordings remain in the capture director's browser cache.";
  if (mode === "direct") return "Uses the selected server only to exchange WebRTC offers and ICE candidates. Media, control and recordings remain peer-to-peer, with recordings cached in the capture director's browser.";
  return "Uses the configured TURN service when a direct connection is unavailable.";
}

export function rtcConfigurationForConnectionProfile(profile: ConnectionProfile, relayedIceServers: RTCIceServer[] | null = null): RTCConfiguration {
  return {
    iceServers: profile.mode === "local"
      ? []
      : relayedIceServers ?? configuredIceServers,
    iceCandidatePoolSize: profile.mode === "local" ? 0 : 2,
  };
}
