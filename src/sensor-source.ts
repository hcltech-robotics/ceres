export const syntheticSensorSourceRequested = (
  search: string,
  browserTestsEnabled: boolean,
) => browserTestsEnabled && new URLSearchParams(search).get("simulation") === "1";

const IWER_XR_SYSTEM_SYMBOL = "@iwer/xr-system";

const hasIwerXrSystemSymbol = (xr: unknown) => {
  if ((typeof xr !== "object" || xr === null) && typeof xr !== "function") {
    return false;
  }
  try {
    return Object.getOwnPropertySymbols(xr).some((symbol) => symbol.description === IWER_XR_SYSTEM_SYMBOL);
  } catch {
    return false;
  }
};

export const iwerRuntimeDetected = (runtime: {
  IWER?: unknown;
  IWER_DEVICE?: unknown;
  __IWER_MCP_MANAGED?: boolean;
  navigator?: { xr?: unknown };
}) => Boolean(runtime.IWER || runtime.IWER_DEVICE || runtime.__IWER_MCP_MANAGED)
  || hasIwerXrSystemSymbol(runtime.navigator?.xr);
