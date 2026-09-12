export interface TurnLease {
  permitId: string;
  expiresAt: string;
  iceServers: RTCIceServer[];
}

export const turnLeaseMinimumValidityMs = 5_000;

export function activeTurnLease(
  permit: TurnLease | null,
  now = Date.now(),
  minimumValidityMs = turnLeaseMinimumValidityMs,
) {
  return permit && Date.parse(permit.expiresAt) > now + minimumValidityMs ? permit : null;
}

export type TurnFallbackState = "idle" | "requesting" | "active";

export class TurnFallbackLease {
  private stateValue: TurnFallbackState = "idle";
  private generationValue = 0;
  private permitValue: TurnLease | null = null;

  get state() {
    return this.stateValue;
  }

  beginRequest() {
    if (this.stateValue !== "idle") return null;
    this.generationValue += 1;
    this.stateValue = "requesting";
    this.permitValue = null;
    return this.generationValue;
  }

  isCurrent(generation: number) {
    return generation === this.generationValue;
  }

  accept(generation: number, permit: TurnLease, now = Date.now()) {
    if (!this.isCurrent(generation) || this.stateValue !== "requesting") return null;
    const activePermit = activeTurnLease(permit, now);
    if (!activePermit) {
      this.stateValue = "idle";
      this.permitValue = null;
      return null;
    }
    this.stateValue = "active";
    this.permitValue = activePermit;
    return activePermit;
  }

  fail(generation: number) {
    if (!this.isCurrent(generation)) return false;
    this.stateValue = "idle";
    this.permitValue = null;
    return true;
  }

  activePermit(now = Date.now()) {
    const permit = activeTurnLease(this.permitValue, now);
    if (!permit && this.stateValue === "active") this.reset();
    return permit;
  }

  reset() {
    this.generationValue += 1;
    this.stateValue = "idle";
    this.permitValue = null;
  }
}

export class TurnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnError";
  }
}

function validIceServer(value: unknown): value is RTCIceServer {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<RTCIceServer>;
  const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
  if (urls.length === 0 || urls.some((url) => typeof url !== "string" || !/^(stun|turn|turns):/i.test(url))) return false;
  return (server.username === undefined || typeof server.username === "string")
    && (server.credential === undefined || typeof server.credential === "string");
}

export function normaliseTurnLease(value: unknown): TurnLease | null {
  if (!value || typeof value !== "object") return null;
  const permit = value as Partial<TurnLease>;
  if (typeof permit.permitId !== "string" || !/^permit_[A-Za-z0-9_-]{16,}$/.test(permit.permitId)) return null;
  if (typeof permit.expiresAt !== "string" || Number.isNaN(Date.parse(permit.expiresAt))) return null;
  if (!Array.isArray(permit.iceServers) || permit.iceServers.length === 0 || permit.iceServers.length > 8 || !permit.iceServers.every(validIceServer)) return null;
  return { permitId: permit.permitId, expiresAt: permit.expiresAt, iceServers: permit.iceServers };
}
