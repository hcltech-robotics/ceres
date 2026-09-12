import type { UploadCompletionVerifier } from "./session-store.js";

const integrations = process.env.CERES_ALLOW_HUGGING_FACE === "1"
  ? " https://huggingface.co https://*.huggingface.co https://*.xethub.hf.co https://*.hf.co"
  : "";
const gist = process.env.CERES_ALLOW_GIST === "1" ? " https://api.github.com https://gist.githubusercontent.com" : "";
export const contentSecurityPolicy = `default-src 'self'; base-uri 'self'; connect-src 'self' blob: data:${integrations}${gist}; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data: blob:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:`;

export function createUploadVerifier(): UploadCompletionVerifier | undefined { return undefined; }
export function isOperationalRouteRequest(_request: string) { return true; }
export function resolvePublicRouteRequest(request: string): { kind: "redirect"; location: string; statusCode: 308 } | null {
  const url = new URL(request, "http://localhost");
  if (url.pathname === "/" && url.searchParams.has("session")) {
    return { kind: "redirect", location: `/launch/capture/${url.search}`, statusCode: 308 };
  }
  if (url.pathname === "/solo" || url.pathname === "/solo/") {
    url.searchParams.set("mode", "solo");
    return { kind: "redirect", location: `/launch/capture/?${url.searchParams}`, statusCode: 308 };
  }
  if (["/bridge", "/monitor", "/launch/capture"].includes(url.pathname)) {
    return { kind: "redirect", location: `${url.pathname}/${url.search}`, statusCode: 308 };
  }
  return null;
}
