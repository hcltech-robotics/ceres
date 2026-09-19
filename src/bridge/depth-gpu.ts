import type { DepthSourceFormat } from "../../shared/bridge-depth.js";

export interface GpuDepthImage {
  width: number;
  height: number;
  rawValueToMeters: number;
  texture: WebGLTexture;
  textureType: "texture" | "texture-array";
  imageIndex?: number | null;
  isValid?: boolean;
  depthNear?: number;
  depthFar?: number;
}
export function gpuDepthEncoding(image: Pick<GpuDepthImage, "depthNear" | "depthFar">, format: DepthSourceFormat) {
  const near = image.depthNear, far = image.depthFar;
  return format !== "luminance-alpha" && typeof near === "number" && Number.isFinite(near) && near > 0
    && typeof far === "number" && far > near && (Number.isFinite(far) || far === Infinity)
    ? "perspective" as const : "linear" as const;
}
interface Program {
  program: WebGLProgram;
  size: WebGLUniformLocation | null;
  sourceSize: WebGLUniformLocation | null;
  scale: WebGLUniformLocation | null;
  layer: WebGLUniformLocation | null;
  projection: WebGLUniformLocation | null;
}
const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
export function depthPackingShader(format: DepthSourceFormat, array: boolean): string {
  const integer = format === "unsigned-short";
  return `#version 300 es
precision highp float;
precision highp int;
uniform highp ${integer ? "u" : ""}sampler2D${array ? "Array" : ""} source;
uniform ivec2 outputSize;
uniform ivec2 sourceSize;
uniform float metresPerRaw;
uniform int layer;
uniform vec2 depthProjection;
out vec4 packedDepth;
void main() {
  ivec2 p = min(ivec2(gl_FragCoord.xy * vec2(sourceSize) / vec2(outputSize)), sourceSize - 1);
  ${integer ? "uvec4" : "vec4"} raw = texelFetch(source, ${array ? "ivec3(p, layer)" : "p"}, 0);
  float value = ${format === "luminance-alpha" ? "floor(raw.r * 255.0 + 0.5) + floor(raw.a * 255.0 + 0.5) * 256.0" : "float(raw.r)"};
  float metres = value * metresPerRaw;
  if (depthProjection.x > 0.0) {
    // Quest textures contain normalised OpenGL depth when clipping planes are supplied.
    // near / (1 - depth + depth * near / far) also supports an infinite far plane.
    float denominator = 1.0 - value + value * depthProjection.y;
    metres = (value >= 0.0 && value < 1.0 && denominator > 0.0)
      ? metresPerRaw * depthProjection.x / denominator : 0.0;
  }
  float mm = metres * 1000.0;
  uint depth = (!isnan(mm) && !isinf(mm) && mm >= 0.5 && mm < 65535.5) ? uint(floor(mm + 0.5)) : 0u;
  packedDepth = vec4(float(depth & 255u), float(depth >> 8), 0.0, 255.0) / 255.0;
}`;
}

/** One owned PBO/fence. The XR texture is sampled only during its valid callback. */
export class DepthGpuReadback {
  private framebuffer: WebGLFramebuffer | null = null;
  private output: WebGLTexture | null = null;
  private pbo: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private programs = new Map<string, Program>();
  private fence: WebGLSync | null = null;
  private width = 0;
  private height = 0;
  private readonly bytes = new Uint8Array(256 * 256 * 4);
  constructor(private readonly gl: WebGL2RenderingContext) {
    if (typeof gl.fenceSync !== "function" || gl.isContextLost()) throw new Error("Depth readback requires WebGL 2");
    try {
      this.withState(() => {
        this.framebuffer = gl.createFramebuffer();
        this.output = gl.createTexture();
        this.pbo = gl.createBuffer();
        this.vao = gl.createVertexArray();
        if (!this.framebuffer || !this.output || !this.pbo || !this.vao) throw new Error("Depth GPU allocation failed");
        gl.bindTexture(gl.TEXTURE_2D, this.output);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 256);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.output, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error("Depth readback framebuffer is incomplete");
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.bytes.length, gl.STREAM_READ);
        for (const format of ["luminance-alpha", "float32", "unsigned-short"] as const) {
          for (const array of [false, true]) this.programs.set(`${format}/${array}`, this.compile(format, array));
        }
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  get busy() { return this.fence !== null; }
  capture(image: GpuDepthImage, format: DepthSourceFormat, width: number, height: number): boolean {
    const gl = this.gl;
    if (image.isValid === false || this.busy) return false;
    if (gl.isContextLost()) throw new Error("Depth graphics context was lost");
    const array = image.textureType === "texture-array";
    if (image.textureType !== "texture" && !array) throw new Error("Unsupported depth texture type");
    if (array && (!Number.isInteger(image.imageIndex) || image.imageIndex! < 0)) throw new Error("Invalid depth texture layer");
    const near = image.depthNear, far = image.depthFar;
    const perspective = gpuDepthEncoding(image, format) === "perspective";
    // Meta exposes normalised depth textures even when the declared format is
    // unsigned-short. A usampler on DEPTH_COMPONENT16 rejects the draw.
    const program = this.programs.get(`${perspective ? "float32" : format}/${array}`)!;
    this.withState(() => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.viewport(0, 0, width, height);
      for (const cap of [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD, gl.DITHER]) gl.disable(cap);
      gl.colorMask(true, true, true, true);
      gl.useProgram(program.program);
      gl.bindVertexArray(this.vao);
      gl.bindSampler(0, null);
      gl.bindTexture(array ? gl.TEXTURE_2D_ARRAY : gl.TEXTURE_2D, image.texture);
      gl.uniform2i(program.size, width, height);
      gl.uniform2i(program.sourceSize, image.width, image.height);
      gl.uniform1f(program.scale, image.rawValueToMeters);
      gl.uniform1i(program.layer, image.imageIndex ?? 0);
      gl.uniform2f(program.projection, perspective ? near! : 0, perspective ? near! / far! : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const sampleError = gl.getError();
      if (sampleError !== gl.NO_ERROR) throw new Error(`Depth GPU sampling failed (WebGL ${sampleError})`);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
      gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      const readError = gl.getError();
      if (readError !== gl.NO_ERROR) throw new Error(`Depth GPU readback failed (WebGL ${readError})`);
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (!this.fence) throw new Error("Depth readback fence failed");
      gl.flush();
    });
    this.width = width;
    this.height = height;
    return true;
  }
  poll(): Uint16Array<ArrayBuffer> | null {
    if (!this.fence) return null;
    const gl = this.gl;
    const state = gl.clientWaitSync(this.fence, 0, 0);
    if (state === gl.TIMEOUT_EXPIRED) return null;
    if (state === gl.WAIT_FAILED || gl.isContextLost()) {
      this.cancel();
      throw new Error("Depth GPU readback failed");
    }
    const previous = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    try {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.bytes, 0, this.width * this.height * 4);
    } finally {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previous);
      this.cancel();
    }
    const result = new Uint16Array(this.width * this.height);
    for (let i = 0; i < result.length; i++) result[i] = this.bytes[i * 4] | this.bytes[i * 4 + 1] << 8;
    return result;
  }
  cancel() {
    if (this.fence) this.gl.deleteSync(this.fence);
    this.fence = null;
  }
  dispose() {
    this.cancel();
    for (const { program } of this.programs.values()) this.gl.deleteProgram(program);
    this.programs.clear();
    this.gl.deleteFramebuffer(this.framebuffer);
    this.gl.deleteTexture(this.output);
    this.gl.deleteBuffer(this.pbo);
    this.gl.deleteVertexArray(this.vao);
    this.framebuffer = this.output = this.pbo = this.vao = null;
  }
  private compile(format: DepthSourceFormat, array: boolean): Program {
    const gl = this.gl;
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram();
    if (!program) throw new Error("Depth shader allocation failed");
    try {
      for (const [kind, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, depthPackingShader(format, array)]] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error("Depth shader allocation failed");
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`Depth shader failed: ${gl.getShaderInfoLog(shader)}`);
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Depth program failed: ${gl.getProgramInfoLog(program)}`);
      gl.useProgram(program);
      gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
      return { program, size: gl.getUniformLocation(program, "outputSize"), sourceSize: gl.getUniformLocation(program, "sourceSize"),
        scale: gl.getUniformLocation(program, "metresPerRaw"), layer: gl.getUniformLocation(program, "layer"),
        projection: gl.getUniformLocation(program, "depthProjection") };
    } catch (error) {
      gl.deleteProgram(program);
      throw error;
    } finally {
      shaders.forEach(shader => gl.deleteShader(shader));
    }
  }
  private withState<T>(operation: () => T): T {
    const gl = this.gl;
    const active = gl.getParameter(gl.ACTIVE_TEXTURE);
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.getParameter(gl.TEXTURE_BINDING_2D), array = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    const sampler = gl.getParameter(gl.SAMPLER_BINDING);
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING), vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const program = gl.getParameter(gl.CURRENT_PROGRAM), viewport = gl.getParameter(gl.VIEWPORT);
    const mask = gl.getParameter(gl.COLOR_WRITEMASK);
    const packNames = [gl.PACK_ALIGNMENT, gl.PACK_ROW_LENGTH, gl.PACK_SKIP_ROWS, gl.PACK_SKIP_PIXELS];
    const packValues = packNames.map(name => gl.getParameter(name));
    const caps = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST, gl.STENCIL_TEST, gl.RASTERIZER_DISCARD, gl.DITHER];
    const enabled = caps.map(cap => gl.isEnabled(cap));
    try { return operation(); }
    finally {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      gl.bindVertexArray(vao);
      gl.useProgram(program);
      gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      gl.colorMask(mask[0], mask[1], mask[2], mask[3]);
      packNames.forEach((name, i) => gl.pixelStorei(name, packValues[i]));
      caps.forEach((cap, i) => enabled[i] ? gl.enable(cap) : gl.disable(cap));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, array);
      gl.bindSampler(0, sampler);
      gl.activeTexture(active);
    }
  }
}
