import * as THREE from "three";

export interface Renderer3DOptions {
  canvas: HTMLCanvasElement;
  antialias?: boolean;
  quality?: "low" | "normal" | "high";
}

export class Renderer3D101 {
  readonly renderer: THREE.WebGLRenderer | Renderer3DFallback;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly available: boolean;

  constructor(options: Renderer3DOptions) {
    try {
      const rendererOptions = {
        antialias: options.antialias ?? options.quality !== "low",
        powerPreference: options.quality === "high" ? "high-performance" as const : "default" as const,
      };
      const context = (options.canvas.getContext("webgl2", rendererOptions) as WebGL2RenderingContext | null)
        ?? (options.canvas.getContext("webgl", rendererOptions) as WebGLRenderingContext | null);
      if (!context) throw new Error("WebGL is unavailable");
      this.renderer = new THREE.WebGLRenderer({
        canvas: options.canvas,
        context,
        ...rendererOptions,
      });
      this.available = true;
    } catch {
      this.renderer = new Renderer3DFallback(options.canvas);
      this.available = false;
    }
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 2000);
    this.camera.position.set(0, 0, 5);
  }

  resize(width: number, height: number, pixelRatio = devicePixelRatio) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(pixelRatio, 2));
    this.renderer.setSize(width, height, false);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.renderer.dispose();
  }
}

class Renderer3DFallback {
  private readonly context: CanvasRenderingContext2D | null;
  private background = "#090b0b";
  private width = 1;
  private height = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("2d");
  }

  setClearColor(color: THREE.ColorRepresentation) {
    this.background = `#${new THREE.Color(color).getHexString()}`;
  }

  setPixelRatio() {}

  setSize(width: number, height: number) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  render() {
    if (!this.context) return;
    this.context.fillStyle = this.background;
    this.context.fillRect(0, 0, this.width, this.height);
    this.context.strokeStyle = "rgba(181,255,102,.32)";
    this.context.lineWidth = 2;
    this.context.strokeRect(18, 18, Math.max(1, this.width - 36), Math.max(1, this.height - 36));
    this.context.fillStyle = "#eff1e8";
    this.context.font = "600 15px system-ui, sans-serif";
    this.context.textAlign = "center";
    this.context.fillText("3D DISPLAY UNAVAILABLE", this.width / 2, this.height / 2 - 7);
    this.context.fillStyle = "#8d9791";
    this.context.font = "12px system-ui, sans-serif";
    this.context.fillText("GAMEPLAY + INPUT CONTINUE", this.width / 2, this.height / 2 + 16);
  }

  dispose() {}
}

export { THREE };
