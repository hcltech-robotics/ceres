export type ReductionBackend = "webgpu" | "wasm-cpu";

export interface ReducibleExporter {
  pendingReductionRows(): number;
  pendingReductionDimensions(): number;
  pendingReductionValues(): Float32Array;
  acceptGpuReduction(
    counts: Uint32Array,
    means: Float32Array,
    m2: Float32Array,
    minimums: Float32Array,
    maximums: Float32Array,
  ): void;
  reducePendingCpu(): void;
}

interface GpuBufferLike {
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
  destroy(): void;
}

interface GpuDeviceLike {
  createShaderModule(descriptor: { code: string }): unknown;
  createComputePipelineAsync(descriptor: unknown): Promise<{
    getBindGroupLayout(index: number): unknown;
  }>;
  createBuffer(descriptor: {
    size: number;
    usage: number;
    mappedAtCreation?: boolean;
  }): GpuBufferLike;
  createBindGroup(descriptor: unknown): unknown;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, group: unknown): void;
      dispatchWorkgroups(count: number): void;
      end(): void;
    };
    copyBufferToBuffer(
      source: GpuBufferLike,
      sourceOffset: number,
      destination: GpuBufferLike,
      destinationOffset: number,
      size: number,
    ): void;
    finish(): unknown;
  };
  queue: { submit(commands: unknown[]): void };
}

interface GpuProvider {
  requestAdapter(): Promise<{
    requestDevice(): Promise<GpuDeviceLike>;
  } | null>;
}

const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_UNIFORM = 0x0040;
const BUFFER_STORAGE = 0x0080;
const MAP_MODE_READ = 0x0001;
const STAT_STRIDE_BYTES = 24;

export const REDUCTION_SHADER = String.raw`
struct Params {
  rows: u32,
  dimensions: u32,
  pad0: u32,
  pad1: u32,
}

struct Stat {
  count: u32,
  mean: f32,
  m2: f32,
  minimum: f32,
  maximum: f32,
  pad: f32,
}

@group(0) @binding(0) var<storage, read> input_values: array<f32>;
@group(0) @binding(1) var<storage, read_write> output_stats: array<Stat>;
@group(0) @binding(2) var<uniform> params: Params;

var<workgroup> counts: array<u32, 256>;
var<workgroup> means: array<f32, 256>;
var<workgroup> m2s: array<f32, 256>;
var<workgroup> minimums: array<f32, 256>;
var<workgroup> maximums: array<f32, 256>;

@compute @workgroup_size(256)
fn reduce_dimension(
  @builtin(workgroup_id) workgroup_id: vec3<u32>,
  @builtin(local_invocation_id) local_id: vec3<u32>,
) {
  let dimension = workgroup_id.x;
  let lane = local_id.x;
  if (dimension >= params.dimensions) {
    return;
  }

  var local_count = 0u;
  var local_mean = 0.0;
  var local_m2 = 0.0;
  var local_minimum = 3.402823466e+38;
  var local_maximum = -3.402823466e+38;
  var row = lane;
  loop {
    if (row >= params.rows) {
      break;
    }
    let value = input_values[row * params.dimensions + dimension];
    local_count = local_count + 1u;
    let delta = value - local_mean;
    local_mean = local_mean + delta / f32(local_count);
    local_m2 = local_m2 + delta * (value - local_mean);
    local_minimum = min(local_minimum, value);
    local_maximum = max(local_maximum, value);
    row = row + 256u;
  }

  counts[lane] = local_count;
  means[lane] = local_mean;
  m2s[lane] = local_m2;
  minimums[lane] = local_minimum;
  maximums[lane] = local_maximum;
  workgroupBarrier();

  var offset = 128u;
  loop {
    if (offset == 0u) {
      break;
    }
    if (lane < offset && counts[lane + offset] > 0u) {
      let left_count = counts[lane];
      let right_count = counts[lane + offset];
      if (left_count == 0u) {
        counts[lane] = right_count;
        means[lane] = means[lane + offset];
        m2s[lane] = m2s[lane + offset];
        minimums[lane] = minimums[lane + offset];
        maximums[lane] = maximums[lane + offset];
      } else {
        let combined_count = left_count + right_count;
        let delta = means[lane + offset] - means[lane];
        m2s[lane] = m2s[lane] + m2s[lane + offset]
          + delta * delta * f32(left_count) * f32(right_count) / f32(combined_count);
        means[lane] = means[lane] + delta * f32(right_count) / f32(combined_count);
        counts[lane] = combined_count;
        minimums[lane] = min(minimums[lane], minimums[lane + offset]);
        maximums[lane] = max(maximums[lane], maximums[lane + offset]);
      }
    }
    workgroupBarrier();
    offset = offset / 2u;
  }

  if (lane == 0u) {
    output_stats[dimension].count = counts[0];
    output_stats[dimension].mean = means[0];
    output_stats[dimension].m2 = max(m2s[0], 0.0);
    output_stats[dimension].minimum = minimums[0];
    output_stats[dimension].maximum = maximums[0];
    output_stats[dimension].pad = 0.0;
  }
}
`;

function browserGpu(): GpuProvider | undefined {
  const scope = globalThis as typeof globalThis & {
    navigator?: Navigator & { gpu?: GpuProvider };
  };
  return scope.navigator?.gpu;
}

async function reduceWithWebGpu(exporter: ReducibleExporter, gpu: GpuProvider): Promise<void> {
  const rows = exporter.pendingReductionRows();
  const dimensions = exporter.pendingReductionDimensions();
  const values = exporter.pendingReductionValues();
  if (rows === 0) return;
  if (values.length !== rows * dimensions) {
    throw new Error("pending reduction values do not match their declared shape");
  }

  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter is unavailable");
  const device = await adapter.requestDevice();
  const input = device.createBuffer({
    size: values.byteLength,
    usage: BUFFER_STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(input.getMappedRange()).set(values);
  input.unmap();

  const outputSize = dimensions * STAT_STRIDE_BYTES;
  const output = device.createBuffer({ size: outputSize, usage: BUFFER_STORAGE | BUFFER_COPY_SRC });
  const readback = device.createBuffer({ size: outputSize, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
  const params = device.createBuffer({ size: 16, usage: BUFFER_UNIFORM, mappedAtCreation: true });
  new Uint32Array(params.getMappedRange()).set([rows, dimensions, 0, 0]);
  params.unmap();

  try {
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto",
      compute: {
        module: device.createShaderModule({ code: REDUCTION_SHADER }),
        entryPoint: "reduce_dimension",
      },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(dimensions);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, outputSize);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(MAP_MODE_READ);

    const view = new DataView(readback.getMappedRange());
    const counts = new Uint32Array(dimensions);
    const means = new Float32Array(dimensions);
    const m2 = new Float32Array(dimensions);
    const minimums = new Float32Array(dimensions);
    const maximums = new Float32Array(dimensions);
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const offset = dimension * STAT_STRIDE_BYTES;
      counts[dimension] = view.getUint32(offset, true);
      means[dimension] = view.getFloat32(offset + 4, true);
      m2[dimension] = view.getFloat32(offset + 8, true);
      minimums[dimension] = view.getFloat32(offset + 12, true);
      maximums[dimension] = view.getFloat32(offset + 16, true);
    }
    readback.unmap();
    exporter.acceptGpuReduction(counts, means, m2, minimums, maximums);
  } finally {
    input.destroy();
    output.destroy();
    readback.destroy();
    params.destroy();
  }
}

export async function reducePending(
  exporter: ReducibleExporter,
  gpu: GpuProvider | undefined = browserGpu(),
): Promise<ReductionBackend> {
  if (exporter.pendingReductionRows() === 0) return "wasm-cpu";
  if (gpu) {
    try {
      await reduceWithWebGpu(exporter, gpu);
      return "webgpu";
    } catch {
      // The Rust fallback is deterministic and owns the authoritative statistics state.
    }
  }
  exporter.reducePendingCpu();
  return "wasm-cpu";
}
