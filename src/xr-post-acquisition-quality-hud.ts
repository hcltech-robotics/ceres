import {
  CanvasTexture,
  FrontSide,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from "three";
import type {
  SoloRunQualityBin,
  SoloRunQualityDelineation,
  SoloRunQualityResult,
} from "./solo-run-quality.js";
import {
  SoloPostAcquisitionQualityTimeline,
  type SoloPostAcquisitionQualityFrame,
} from "./solo-post-acquisition-quality.js";
import {
  xrCameraEdgesPresentation,
  XR_CAMERA_EDGES_CANVAS_SIZE,
  XR_CAMERA_EDGES_DISTANCE_M,
  XR_CAMERA_EDGES_PLANE_SIZE_M,
  XR_CAPTURE_CENTRE_Y_M,
  type XrCameraEdgesPresentation,
} from "./xr-task-hud.js";

export const XR_POST_ACQUISITION_QUALITY_WIDTH_M = .42;
export const XR_POST_ACQUISITION_QUALITY_HEIGHT_M = .12;
export const XR_POST_ACQUISITION_QUALITY_RETICLE_INSET_M = .025;

export function xrPostAcquisitionQualityReticlePosition(
  frame: Pick<XrCameraEdgesPresentation, "bottom" | "left">,
  canvasWidth: number,
  canvasHeight: number,
) {
  const frameLeft = (frame.left / canvasWidth - .5) * XR_CAMERA_EDGES_PLANE_SIZE_M;
  const frameBottom = XR_CAPTURE_CENTRE_Y_M
    + (.5 - frame.bottom / canvasHeight) * XR_CAMERA_EDGES_PLANE_SIZE_M;
  return {
    x: frameLeft
      + XR_POST_ACQUISITION_QUALITY_RETICLE_INSET_M
      + XR_POST_ACQUISITION_QUALITY_WIDTH_M / 2,
    y: frameBottom
      + XR_POST_ACQUISITION_QUALITY_RETICLE_INSET_M
      + XR_POST_ACQUISITION_QUALITY_HEIGHT_M / 2,
    z: -XR_CAMERA_EDGES_DISTANCE_M,
  };
}

const DEFAULT_RETICLE_FRAME = xrCameraEdgesPresentation(
  XR_CAMERA_EDGES_CANVAS_SIZE,
  XR_CAMERA_EDGES_CANVAS_SIZE,
  4 / 3,
  0,
  true,
);
export const XR_POST_ACQUISITION_QUALITY_POSITION = Object.freeze(
  xrPostAcquisitionQualityReticlePosition(
    DEFAULT_RETICLE_FRAME,
    XR_CAMERA_EDGES_CANVAS_SIZE,
    XR_CAMERA_EDGES_CANVAS_SIZE,
  ),
);

const QUALITY_CANVAS_WIDTH_PX = 768;
const QUALITY_CANVAS_HEIGHT_PX = 220;
export const XR_POST_ACQUISITION_QUALITY_PIXEL_RATIO = 2;
const QUALITY_PLOT_LEFT_PX = 38;
const QUALITY_PLOT_RIGHT_PX = 14;
const QUALITY_PLOT_TOP_PX = 46;
const QUALITY_PLOT_BOTTOM_PX = 150;
const QUALITY_RUG_HEIGHT_PX = 17;
const QUALITY_LEFT_RUG_Y_PX = 166;
const QUALITY_RIGHT_RUG_Y_PX = 192;

export const XR_POST_ACQUISITION_CHART_COLOURS = Object.freeze({
  left: "#5fd5ff",
  right: "#ffc466",
  visible: "#52d273",
  missing: "#ff6b78",
  unknown: "#718096",
  grid: "rgba(181, 202, 224, .18)",
  boundary: "rgba(230, 239, 249, .38)",
  text: "rgba(239, 245, 252, .90)",
});

export const XR_POST_ACQUISITION_QUALITY_RASTER_MEASURE =
  "ceres.xr.post-acquisition-quality.raster";
export const XR_POST_ACQUISITION_QUALITY_PRESENT_MEASURE =
  "ceres.xr.post-acquisition-quality.present";

export interface XrPostAcquisitionQualityPresentation {
  readonly key: string;
  readonly result: SoloRunQualityResult;
}

export class XrPostAcquisitionQualityHud {
  readonly group = new Group();

  private readonly entity: any;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: CanvasTexture;
  private readonly material: MeshBasicMaterial;
  private readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly timeline: SoloPostAcquisitionQualityTimeline;
  private presentation: XrPostAcquisitionQualityPresentation | null = null;
  private displayFrame: SoloPostAcquisitionQualityFrame = { opacity: 0, state: "hidden" };
  private xrSession: object | null = null;
  private surfaceVisible = false;
  private rasterGeneration = 0;
  private rasterTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    world: any,
    private readonly onNeedsXrFrame: () => void = () => {},
  ) {
    this.group.name = "ceres-solo-post-acquisition-quality";
    this.group.position.set(
      XR_POST_ACQUISITION_QUALITY_POSITION.x,
      XR_POST_ACQUISITION_QUALITY_POSITION.y,
      XR_POST_ACQUISITION_QUALITY_POSITION.z,
    );
    this.group.visible = false;

    this.canvas.width = QUALITY_CANVAS_WIDTH_PX * XR_POST_ACQUISITION_QUALITY_PIXEL_RATIO;
    this.canvas.height = QUALITY_CANVAS_HEIGHT_PX * XR_POST_ACQUISITION_QUALITY_PIXEL_RATIO;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
    this.material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: FrontSide,
      toneMapped: false,
    });
    this.mesh = new Mesh(
      new PlaneGeometry(
        XR_POST_ACQUISITION_QUALITY_WIDTH_M,
        XR_POST_ACQUISITION_QUALITY_HEIGHT_M,
      ),
      this.material,
    );
    this.mesh.name = "ceres-solo-quality-speed-rug";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1_101;
    this.group.add(this.mesh);
    this.timeline = new SoloPostAcquisitionQualityTimeline((frame) => {
      this.displayFrame = frame;
      this.material.opacity = frame.opacity;
      this.applyVisibility();
    });
    this.entity = world.createTransformEntity(this.group, {
      parent: world.playerHeadEntity,
      persistent: true,
    });
  }

  setReticleFrame(
    frame: Pick<XrCameraEdgesPresentation, "bottom" | "left">,
    canvasWidth: number,
    canvasHeight: number,
  ) {
    const position = xrPostAcquisitionQualityReticlePosition(frame, canvasWidth, canvasHeight);
    this.group.position.set(position.x, position.y, position.z);
  }

  get needsXrFrame() {
    return this.timeline.needsFrame;
  }

  setXrSession(session: object | null) {
    if (this.xrSession === session) return;
    this.xrSession = session;
    this.surfaceVisible = false;
    this.timeline.pauseForSession();
    this.applyVisibility();
  }

  setSurfaceVisible(visible: boolean, reducedMotion = false) {
    const surfaceVisible = this.xrSession !== null && visible;
    this.surfaceVisible = surfaceVisible;
    this.timeline.setSurfaceVisible(surfaceVisible, reducedMotion);
    this.applyVisibility();
  }

  advanceXrFrame(timestampMs: number) {
    this.timeline.advance(timestampMs);
  }

  update(presentation: XrPostAcquisitionQualityPresentation | null) {
    if (this.presentation?.key === presentation?.key
      && this.presentation?.result === presentation?.result) return;
    const generation = ++this.rasterGeneration;
    if (this.rasterTimer !== null) clearTimeout(this.rasterTimer);
    this.rasterTimer = null;
    this.mesh.onAfterRender = () => {};
    this.presentation = presentation;
    this.timeline.clear();
    if (!presentation) return;
    const renderStartedAt = performance.now();
    const stages = qualityChartRasterStages(
      this.canvas.getContext("2d")!,
      presentation.result,
    );
    this.runRasterStage(generation, stages, 0, renderStartedAt);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rasterGeneration += 1;
    if (this.rasterTimer !== null) clearTimeout(this.rasterTimer);
    this.rasterTimer = null;
    this.presentation = null;
    this.xrSession = null;
    this.surfaceVisible = false;
    this.timeline.dispose();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    try {
      this.entity.dispose();
    } catch {
      this.group.removeFromParent();
    }
  }

  private applyVisibility() {
    this.group.visible = !this.disposed
      && this.xrSession !== null
      && this.surfaceVisible
      && this.presentation !== null
      && this.displayFrame.state !== "hidden";
  }

  private runRasterStage(
    generation: number,
    stages: readonly (() => void)[],
    index: number,
    renderStartedAt: number,
  ) {
    if (this.disposed || generation !== this.rasterGeneration) return;
    const stageStartedAt = performance.now();
    stages[index]!();
    performance.measure(XR_POST_ACQUISITION_QUALITY_RASTER_MEASURE, {
      start: stageStartedAt,
      end: performance.now(),
    });
    if (index + 1 < stages.length) {
      this.rasterTimer = setTimeout(() => {
        this.rasterTimer = null;
        this.runRasterStage(generation, stages, index + 1, renderStartedAt);
      }, 0);
      return;
    }
    this.texture.needsUpdate = true;
    this.mesh.onAfterRender = () => {
      if (generation !== this.rasterGeneration) return;
      performance.measure(XR_POST_ACQUISITION_QUALITY_PRESENT_MEASURE, {
        start: renderStartedAt,
        end: performance.now(),
      });
      this.mesh.onAfterRender = () => {};
    };
    this.timeline.present();
    this.onNeedsXrFrame();
  }
}

function qualityChartRasterStages(
  context: CanvasRenderingContext2D,
  result: SoloRunQualityResult,
): readonly (() => void)[] {
  const width = QUALITY_CANVAS_WIDTH_PX;
  const hand = handSpeedSummary(result.bins);
  const maximum = hand.maximum * 1.08;
  return [
    () => {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, context.canvas.width, context.canvas.height);
      context.restore();
      withQualityCanvasTransform(context, () => {
        context.save();
        context.fillStyle = XR_POST_ACQUISITION_CHART_COLOURS.text;
        context.font = "650 15px system-ui, sans-serif";
        context.textBaseline = "middle";
        context.textAlign = "left";
        context.fillText("SPEED (M/S)", 14, 18);
        context.font = "600 13px system-ui, sans-serif";
        context.textAlign = "right";
        context.fillText(
          `L ${formatMetresPerSecond(hand.left)}   R ${formatMetresPerSecond(hand.right)}`,
          width - 14,
          18,
        );
        context.restore();
        drawGrid(context);
        drawDelineations(context, result, result.delineations);
      });
    },
    () => withQualityCanvasTransform(context, () => drawCurve(
      context,
      result.bins,
      "leftHandSpeedMps",
      maximum,
      XR_POST_ACQUISITION_CHART_COLOURS.left,
    )),
    () => withQualityCanvasTransform(context, () => drawCurve(
      context,
      result.bins,
      "rightHandSpeedMps",
      maximum,
      XR_POST_ACQUISITION_CHART_COLOURS.right,
    )),
    () => withQualityCanvasTransform(context, () => {
      drawVisibilityRug(
        context,
        result.bins,
        QUALITY_LEFT_RUG_Y_PX,
        "L",
        "left",
      );
      drawVisibilityRug(
        context,
        result.bins,
        QUALITY_RIGHT_RUG_Y_PX,
        "R",
        "right",
      );
    }),
  ];
}

function withQualityCanvasTransform(
  context: CanvasRenderingContext2D,
  draw: () => void,
) {
  context.save();
  context.setTransform(
    XR_POST_ACQUISITION_QUALITY_PIXEL_RATIO,
    0,
    0,
    XR_POST_ACQUISITION_QUALITY_PIXEL_RATIO,
    0,
    0,
  );
  draw();
  context.restore();
}

function handSpeedSummary(bins: readonly SoloRunQualityBin[]) {
  let leftTotal = 0;
  let leftCount = 0;
  let rightTotal = 0;
  let rightCount = 0;
  let maximum = 1e-6;
  for (const bin of bins) {
    if (bin.leftHandSpeedMps !== null && Number.isFinite(bin.leftHandSpeedMps)) {
      leftTotal += bin.leftHandSpeedMps;
      leftCount += 1;
      maximum = Math.max(maximum, bin.leftHandSpeedMps);
    }
    if (bin.rightHandSpeedMps !== null && Number.isFinite(bin.rightHandSpeedMps)) {
      rightTotal += bin.rightHandSpeedMps;
      rightCount += 1;
      maximum = Math.max(maximum, bin.rightHandSpeedMps);
    }
  }
  return {
    left: leftCount === 0 ? null : leftTotal / leftCount,
    right: rightCount === 0 ? null : rightTotal / rightCount,
    maximum,
  };
}

function formatMetresPerSecond(value: number | null) {
  return value === null ? "--" : value.toFixed(2);
}

export function soloQualityCurveSegments(values: readonly (number | null)[]) {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let segment: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (segment.length > 0) segments.push(segment);
      segment = [];
      return;
    }
    segment.push({ index, value });
  });
  if (segment.length > 0) segments.push(segment);
  return segments;
}

export function soloQualityCurveMarkerRadius(pointCount: number) {
  return pointCount === 1 ? 2 : null;
}

function drawGrid(context: CanvasRenderingContext2D) {
  context.save();
  context.strokeStyle = XR_POST_ACQUISITION_CHART_COLOURS.grid;
  context.lineWidth = 1;
  for (const fraction of [.25, .5, .75]) {
    const y = Math.round(
      QUALITY_PLOT_TOP_PX
      + (QUALITY_PLOT_BOTTOM_PX - QUALITY_PLOT_TOP_PX) * fraction,
    ) + .5;
    context.beginPath();
    context.moveTo(QUALITY_PLOT_LEFT_PX, y);
    context.lineTo(QUALITY_CANVAS_WIDTH_PX - QUALITY_PLOT_RIGHT_PX, y);
    context.stroke();
  }
  context.restore();
}

function drawCurve(
  context: CanvasRenderingContext2D,
  bins: readonly SoloRunQualityBin[],
  key: "leftHandSpeedMps" | "rightHandSpeedMps",
  maximum: number,
  colour: string,
) {
  if (bins.length === 0) return;
  const width = QUALITY_CANVAS_WIDTH_PX - QUALITY_PLOT_LEFT_PX - QUALITY_PLOT_RIGHT_PX;
  const height = QUALITY_PLOT_BOTTOM_PX - QUALITY_PLOT_TOP_PX;
  const denominator = Math.max(1, bins.length - 1);
  context.save();
  context.strokeStyle = colour;
  context.fillStyle = colour;
  context.lineWidth = 3;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.beginPath();
  let pointDrawn = false;
  for (let index = 0; index < bins.length; index += 1) {
    const value = bins[index]![key];
    if (value === null || !Number.isFinite(value)) continue;
    pointDrawn = true;
    const x = QUALITY_PLOT_LEFT_PX + index / denominator * width;
    const y = QUALITY_PLOT_BOTTOM_PX - Math.min(1, Math.max(0, value / maximum)) * height;
    const previous = index > 0 ? bins[index - 1]![key] : null;
    const next = index + 1 < bins.length ? bins[index + 1]![key] : null;
    const previousDefined = previous !== null && Number.isFinite(previous);
    const nextDefined = next !== null && Number.isFinite(next);
    if (!previousDefined && !nextDefined) {
      const markerRadius = soloQualityCurveMarkerRadius(1)!;
      context.moveTo(x + markerRadius, y);
      context.arc(x, y, markerRadius, 0, Math.PI * 2);
    } else if (!previousDefined) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }
  if (pointDrawn) context.stroke();
  context.restore();
}

function drawVisibilityRug(
  context: CanvasRenderingContext2D,
  bins: readonly SoloRunQualityBin[],
  y: number,
  label: string,
  hand: "left" | "right",
) {
  if (bins.length === 0) return;
  const width = QUALITY_CANVAS_WIDTH_PX - QUALITY_PLOT_LEFT_PX - QUALITY_PLOT_RIGHT_PX;
  const cellWidth = width / bins.length;
  context.save();
  context.fillStyle = XR_POST_ACQUISITION_CHART_COLOURS.text;
  context.font = "650 13px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, QUALITY_PLOT_LEFT_PX / 2, y + QUALITY_RUG_HEIGHT_PX / 2);
  bins.forEach((bin, index) => {
    if (bin.unrecordedFraction >= .999) return;
    const visibility = hand === "left" ? bin.leftVisibility : bin.rightVisibility;
    context.fillStyle = bin.recorderGapFraction > 0 || visibility === null
      ? XR_POST_ACQUISITION_CHART_COLOURS.unknown
      : visibility >= .999
        ? XR_POST_ACQUISITION_CHART_COLOURS.visible
        : XR_POST_ACQUISITION_CHART_COLOURS.missing;
    context.fillRect(
      QUALITY_PLOT_LEFT_PX + index * cellWidth,
      y,
      Math.max(1, cellWidth + .25),
      QUALITY_RUG_HEIGHT_PX,
    );
  });
  context.restore();
}

function drawDelineations(
  context: CanvasRenderingContext2D,
  quality: Pick<SoloRunQualityResult, "startedAtMs" | "endedAtMs">,
  delineations: readonly SoloRunQualityDelineation[],
) {
  const durationMs = quality.endedAtMs - quality.startedAtMs;
  if (!(durationMs > 0)) return;
  const width = QUALITY_CANVAS_WIDTH_PX - QUALITY_PLOT_LEFT_PX - QUALITY_PLOT_RIGHT_PX;
  const markers = soloQualityDelineationMarkers(quality, delineations, width);
  if (markers.length === 0) return;
  context.save();
  context.strokeStyle = XR_POST_ACQUISITION_CHART_COLOURS.boundary;
  context.fillStyle = XR_POST_ACQUISITION_CHART_COLOURS.text;
  context.font = "600 10px system-ui, sans-serif";
  context.textBaseline = "top";
  context.setLineDash([3, 3]);
  context.beginPath();
  for (const marker of markers) {
    const x = QUALITY_PLOT_LEFT_PX + marker.pixel;
    context.moveTo(x, 29);
    context.lineTo(x, QUALITY_RIGHT_RUG_Y_PX + QUALITY_RUG_HEIGHT_PX);
  }
  context.stroke();
  const occupiedRows: Array<Array<{ start: number; end: number }>> = [[], []];
  for (let priority = 3; priority >= 1; priority -= 1) {
    for (const marker of markers) {
      if (marker.priority !== priority) continue;
      const x = QUALITY_PLOT_LEFT_PX + marker.pixel;
      const label = `C${marker.entry.cycle} | ${marker.entry.taskLabel} | R${marker.entry.repetition}`;
      const measured = context.measureText(label).width;
      const rightAligned = x + measured + 3 > QUALITY_CANVAS_WIDTH_PX - 2;
      const start = rightAligned ? x - measured - 3 : x + 3;
      const end = start + measured;
      const row = occupiedRows.findIndex((entries) => entries.every((entry) => (
        end + 4 < entry.start || start - 4 > entry.end
      )));
      if (row < 0) continue;
      occupiedRows[row]!.push({ start, end });
      context.textAlign = rightAligned ? "right" : "left";
      context.fillText(label, x + (rightAligned ? -3 : 3), row === 0 ? 28 : 38);
    }
  }
  context.restore();
}

export function soloQualityDelineationMarkers(
  quality: Pick<SoloRunQualityResult, "startedAtMs" | "endedAtMs">,
  delineations: readonly SoloRunQualityDelineation[],
  plotWidthPx: number,
) {
  const durationMs = quality.endedAtMs - quality.startedAtMs;
  if (!(durationMs > 0) || !(plotWidthPx > 0)) return [];
  const markers: Array<{
    entry: SoloRunQualityDelineation;
    pixel: number;
    priority: number;
  }> = [];
  for (const entry of delineations) {
    const priority = entry.startsCycle ? 3 : entry.startsTask ? 2 : entry.startsRepetition ? 1 : 0;
    if (priority === 0) continue;
    const fraction = (entry.timestampMs - quality.startedAtMs) / durationMs;
    if (fraction < 0 || fraction > 1) continue;
    const pixel = Math.round(fraction * plotWidthPx);
    const previous = markers.at(-1);
    if (previous?.pixel === pixel) {
      if (priority > previous.priority) markers[markers.length - 1] = { entry, pixel, priority };
      continue;
    }
    markers.push({ entry, pixel, priority });
  }
  return markers;
}
