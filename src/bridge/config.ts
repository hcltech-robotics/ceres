import { relayOrigin } from "./pairing.js";

export function verifyBridgeConfiguration() {
  const attestation = import.meta.env.VITE_CERES_BRIDGE_ATTESTATION || "";
  const deployment = import.meta.env.VITE_CERES_BRIDGE_DEPLOYMENT || "download";
  if (deployment === "vercel" && (!attestation.startsWith("ceres-bridge-v1:") || !relayOrigin.startsWith("https://"))) {
    throw new Error("Hosted Bridge configuration is incomplete");
  }
  return { attestation, relayOrigin, deployment };
}
