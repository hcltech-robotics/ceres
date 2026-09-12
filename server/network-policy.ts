export function serverBindHost(environment: NodeJS.ProcessEnv, secure: boolean): string {
  const configured = environment.CERES_BIND_HOST?.trim();
  if (configured) return configured;
  return secure ? "0.0.0.0" : "127.0.0.1";
}
