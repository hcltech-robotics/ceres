export type ExporterWasmBackend = "wasm-simd" | "wasm-scalar";

export interface LeRobotExportBundle {
  artifactCount(): number;
  artifactPath(index: number): string;
  artifactMediaType(index: number): string;
  artifactBytes(index: number): Uint8Array;
  free(): void;
}

export interface CeresLeRobotExporter {
  pushCeresFrame(sourceFrameIndex: bigint, telemetry: Float64Array, action: Float32Array): void;
  pushCeresSensorFrameJson(frameJson: string): void;
  pushCeresSensorFrameJsonForTask(frameJson: string, taskIndex: bigint): void;
  reductionReady(): boolean;
  pendingReductionRows(): number;
  pendingReductionDimensions(): number;
  pendingReductionValues(): Float32Array;
  reducePendingCpu(): void;
  acceptGpuReduction(
    counts: Uint32Array,
    means: Float32Array,
    m2: Float32Array,
    minimums: Float32Array,
    maximums: Float32Array,
  ): void;
  attachVideo(key: string, metadataJson: string, bytes: Uint8Array): void;
  metricsJson(): string;
  finish(): LeRobotExportBundle;
  free(): void;
}

interface WasmBindings {
  default(input?: { module_or_path: Uint8Array }): Promise<unknown>;
  CeresLeRobotExporter: new (configJson: string) => CeresLeRobotExporter;
  lerobotCompatibilityProfile(): string;
}

export interface LoadedExporterModule {
  backend: ExporterWasmBackend;
  create(config: unknown): CeresLeRobotExporter;
  compatibilityProfile(): unknown;
}

const SIMD_PROBE = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
  0x03, 0x02, 0x01, 0x00,
  0x0a, 0x16, 0x01, 0x14, 0x00, 0xfd, 0x0c,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x0b,
);

export function supportsWasmSimd(): boolean {
  return typeof WebAssembly !== "undefined" && WebAssembly.validate(SIMD_PROBE);
}

export function isMonitorWorker(scope: unknown = globalThis): boolean {
  const candidate = scope as { document?: unknown; postMessage?: unknown };
  return candidate.document === undefined && typeof candidate.postMessage === "function";
}

export async function loadLeRobotExporter(options: {
  preferSimd?: boolean;
  allowOutsideWorkerForTests?: boolean;
  wasmBytesForTests?: Uint8Array;
} = {}): Promise<LoadedExporterModule> {
  if (!options.allowOutsideWorkerForTests && !isMonitorWorker()) {
    throw new Error("the LeRobot exporter may only be loaded by the monitor Web Worker");
  }
  if (typeof WebAssembly === "undefined") {
    throw new Error("WebAssembly is required for the LeRobot exporter");
  }

  const candidates: Array<{ directory: string; backend: ExporterWasmBackend }> = [];
  if (options.preferSimd !== false && supportsWasmSimd()) {
    candidates.push({ directory: "pkg-simd", backend: "wasm-simd" });
  }
  candidates.push({ directory: "pkg-scalar", backend: "wasm-scalar" });

  const failures: string[] = [];
  for (const candidate of candidates) {
    const moduleUrl = typeof location === "undefined"
      ? new URL(`../${candidate.directory}/ceres_lerobot_exporter.js`, import.meta.url).href
      : new URL(
          `/wasm/lerobot-exporter/${candidate.directory}/ceres_lerobot_exporter.js`,
          location.origin,
        ).href;
    try {
      const bindings = (await import(/* @vite-ignore */ moduleUrl)) as WasmBindings;
      await bindings.default(
        options.wasmBytesForTests
          ? { module_or_path: options.wasmBytesForTests }
          : undefined,
      );
      return {
        backend: candidate.backend,
        create: (config) => new bindings.CeresLeRobotExporter(JSON.stringify(config)),
        compatibilityProfile: () => JSON.parse(bindings.lerobotCompatibilityProfile()),
      };
    } catch (error) {
      failures.push(`${candidate.backend}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`unable to load the LeRobot exporter Wasm module: ${failures.join("; ")}`);
}
