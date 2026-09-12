import type { TurnLease } from "./turn-lease.js";

export type UserIdentityState =
  | { status: "loading" | "signed-out" | "unavailable"; user: null }
  | { status: "signed-in"; user: { firstName?: string | null; fullName?: string | null; username?: string | null; imageUrl?: string | null } };
export interface DirectoryInvitation { id: string; inviter: string; sessionId: string; mode: "direct" | "relayed"; expiresAt: string }
export interface IdentityPresentation {
  presentation?: "avatar" | "session";
  onStateChange?: (state: UserIdentityState) => void;
}
export interface InvitationDelivery {
  email: string;
  sessionId: string;
  mode: "direct" | "relayed";
  joinUrl: string;
  expiresAt: string;
}
export interface ApplicationServices {
  uploadWorker?: () => Worker;
  directoryUrl?: string;
  speech?: boolean;
  identity?: (root: HTMLElement, options: IdentityPresentation) => () => void;
  invitations?: {
    list(): Promise<DirectoryInvitation[]>;
    accept(id: string): Promise<string>;
    send(invitation: InvitationDelivery): Promise<string>;
  };
  header?: {
    markup(current: string, identityRootId: string): string;
    mount(root: ParentNode): () => void;
  };
  turn?: {
    fields(sessionId: string): string;
    mount(root: HTMLElement, sessionId: string): () => void;
    request(sessionId: string): Promise<TurnLease>;
  };
}

let services: ApplicationServices = {};
export function configureApplicationServices(value: ApplicationServices) { services = value; }
export function applicationServices() { return services; }

export function mountUserIdentity(root: HTMLElement, options: IdentityPresentation) {
  if (services.identity) return services.identity(root, options);
  root.hidden = true;
  options.onStateChange?.({ status: "unavailable", user: null });
  return () => root.replaceChildren();
}
export function applicationHeaderMarkup(current: string, identityRootId: string) {
  if (services.header) return services.header.markup(current, identityRootId);
  const links = [["director", "/monitor/", "Director"], ["capture", "/launch/capture/", "Capture"], ["solo", "/launch/capture/?mode=solo", "Solo"], ["bridge", "/bridge/", "Bridge"]];
  return `<header class="site-header arrival-header"><a class="site-brand" href="/">CERES</a><nav class="site-nav" aria-label="CERES">${links.map(([id, href, label]) => `<a href="${href}"${current === id ? ' aria-current="page"' : ""}>${label}</a>`).join("")}<a href="https://ceres.cam/documentation/" target="_blank" rel="noopener noreferrer">Documentation</a></nav><div id="${identityRootId}" hidden></div></header>`;
}
export function mountApplicationHeader(root: ParentNode) {
  return services.header?.mount(root) ?? (() => undefined);
}
