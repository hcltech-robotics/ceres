import type { ClientRole } from "../shared/protocol.js";

export const handDisplayAuthorityError = "Only the capture director or demonstrator can change hand display settings";

export function canSetHandDisplay(role: ClientRole): boolean {
  return role === "monitor" || role === "monitor-control" || role === "capture";
}
