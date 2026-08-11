import * as THREE from "three";

export interface Renderer3DOptions {
  canvas: HTMLCanvasElement;
  antialias?: boolean;
  quality?: "low" | "normal" | "high";
}

export class Renderer3D101 {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  constructor(options: Renderer3DOptions) {
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: options.antialias ?? options.quality !== "low",
      powerPreference: options.quality === "high" ? "high-performance" : "default",
    });
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

export { THREE };
