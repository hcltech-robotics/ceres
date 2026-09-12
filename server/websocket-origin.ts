export function isWebSocketOriginAllowed(origin: string | undefined, host: string | undefined, secure: boolean, publicOrigin?: string): boolean {
  if (!origin) return true;
  if (publicOrigin) return origin === publicOrigin;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === (secure ? "https:" : "http:") && parsed.host === host;
  } catch {
    return false;
  }
}
