import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  TextureLoader,
} from "three";

export const XR_STARTUP_INTRO_DURATION_MS = 2_000;
export const XR_STARTUP_INTRO_PROGRESS_DURATION_MS = 1_640;
export const XR_STARTUP_INTRO_REVEAL_AT_MS = XR_STARTUP_INTRO_PROGRESS_DURATION_MS;

export interface XrStartupBuildIdentity {
  version: string;
  codename: string;
  shortCommit: string | null;
}

export interface XrStartupIntroPresentation {
  progress: number;
  logoOpacity: number;
  glitchOpacity: number;
  revealOpacity: number;
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const smoothstep = (start: number, end: number, value: number) => {
  const progress = clamp((value - start) / (end - start));
  return progress * progress * (3 - 2 * progress);
};

export function xrStartupIntroPresentation(
  elapsedMs: number,
  reducedMotion = false,
): XrStartupIntroPresentation {
  const elapsed = clamp(elapsedMs / XR_STARTUP_INTRO_DURATION_MS)
    * XR_STARTUP_INTRO_DURATION_MS;
  const revealOpacity = smoothstep(
    XR_STARTUP_INTRO_REVEAL_AT_MS,
    XR_STARTUP_INTRO_DURATION_MS,
    elapsed,
  );
  const glitchWindow = reducedMotion ? 0 : 1 - smoothstep(180, 420, elapsed);
  const settle = smoothstep(0, 170, elapsed);
  const fade = 1 - revealOpacity;

  return {
    progress: clamp(elapsed / XR_STARTUP_INTRO_PROGRESS_DURATION_MS),
    logoOpacity: fade * (.24 + settle * .48),
    glitchOpacity: glitchWindow * fade,
    revealOpacity,
  };
}

export class XrStartupIntro {
  readonly group = new Group();

  private readonly entity: any;
  private readonly logoMaterial: MeshBasicMaterial;
  private readonly canvas: HTMLCanvasElement;
  private readonly canvasTexture: CanvasTexture;
  private readonly canvasMaterial: MeshBasicMaterial;
  private startedAt: number | null = null;
  private onComplete: (() => void) | null = null;
  private active = false;
  private disposed = false;

  constructor(
    world: any,
    private readonly identity: XrStartupBuildIdentity,
  ) {
    this.group.name = "ceres-xr-startup-intro";
    this.group.position.set(0, .02, -1.02);
    this.group.visible = false;
    this.entity = world.createTransformEntity(this.group, {
      parent: world.cameraEntity,
      persistent: true,
    });

    this.logoMaterial = new MeshBasicMaterial({
      color: "#8bdcff",
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    const logo = new Mesh(new PlaneGeometry(.68, .68), this.logoMaterial);
    logo.name = "CERES startup project mark";
    logo.position.y = .13;
    logo.renderOrder = 2_202;
    this.group.add(logo);
    const loader = new TextureLoader();
    loader.load("/assets/ceres-project-icon.webp", (texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }
      texture.colorSpace = SRGBColorSpace;
      this.logoMaterial.map = texture;
      this.logoMaterial.needsUpdate = true;
    });

    this.canvas = document.createElement("canvas");
    this.canvas.width = 1_024;
    this.canvas.height = 144;
    this.canvasTexture = new CanvasTexture(this.canvas);
    this.canvasTexture.colorSpace = SRGBColorSpace;
    this.canvasMaterial = new MeshBasicMaterial({
      map: this.canvasTexture,
      transparent: true,
      opacity: 0,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
    });
    const information = new Mesh(new PlaneGeometry(.76, .108), this.canvasMaterial);
    information.name = "CERES startup progress and build identity";
    information.position.y = -.31;
    information.position.z = .016;
    information.renderOrder = 2_204;
    this.group.add(information);
  }

  get isActive() {
    return this.active;
  }

  start(onComplete: () => void) {
    if (this.disposed) return;
    this.active = true;
    this.group.visible = true;
    this.startedAt = null;
    this.onComplete = onComplete;
    this.render(xrStartupIntroPresentation(0), 0, this.prefersReducedMotion());
  }

  advance(now: number) {
    if (this.disposed || !this.active) return;
    if (this.startedAt === null) this.startedAt = now;
    const elapsed = Math.max(0, now - this.startedAt);
    const reducedMotion = this.prefersReducedMotion();
    this.render(xrStartupIntroPresentation(elapsed, reducedMotion), elapsed, reducedMotion);
    if (elapsed < XR_STARTUP_INTRO_DURATION_MS) return;
    const onComplete = this.onComplete;
    this.onComplete = null;
    this.active = false;
    this.group.visible = false;
    onComplete?.();
  }

  private prefersReducedMotion() {
    const reducedMotion = typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return reducedMotion;
  }

  cancel() {
    this.active = false;
    this.startedAt = null;
    this.onComplete = null;
    this.group.visible = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.logoMaterial.map?.dispose();
    this.logoMaterial.dispose();
    this.canvasTexture.dispose();
    this.canvasMaterial.dispose();
    try {
      this.entity.dispose();
    } catch {
      this.group.removeFromParent();
    }
  }

  private render(
    presentation: XrStartupIntroPresentation,
    elapsed: number,
    reducedMotion: boolean,
  ) {
    const flicker = reducedMotion ? 1 : .92 + Math.sin(elapsed / 23) * presentation.glitchOpacity * .08;
    this.logoMaterial.opacity = presentation.logoOpacity * flicker;
    this.canvasMaterial.opacity = presentation.logoOpacity;
    this.drawInformation(presentation.progress);
  }

  private drawInformation(progress: number) {
    const context = this.canvas.getContext("2d");
    if (!context) return;
    const { width, height } = this.canvas;
    context.clearRect(0, 0, width, height);
    const x = 72;
    const y = 34;
    const lineWidth = width - x * 2;

    context.fillStyle = "rgba(47, 158, 201, 0.24)";
    context.fillRect(x, y, lineWidth, 6);
    context.fillStyle = "rgba(151, 231, 255, 0.96)";
    context.fillRect(x, y, lineWidth * progress, 6);
    context.fillStyle = "rgba(151, 231, 255, 0.34)";
    context.fillRect(x + lineWidth * progress, y - 3, 2, 12);

    context.textAlign = "center";
    context.fillStyle = "rgba(164, 216, 234, 0.72)";
    context.font = "550 26px Geist, Segoe UI, sans-serif";
    const hash = this.identity.shortCommit && /^[a-f0-9]{7}$/i.test(this.identity.shortCommit)
      ? this.identity.shortCommit
      : "LOCAL";
    context.fillText(`${this.identity.version} ${this.identity.codename}  BUILD ${hash}`, width / 2, 94);
    this.canvasTexture.needsUpdate = true;
  }
}
