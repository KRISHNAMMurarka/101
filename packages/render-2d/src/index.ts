import * as Phaser from "phaser";

export interface Renderer2DOptions {
  parent: HTMLElement | string;
  width?: number;
  height?: number;
  background?: string;
  scenes: Phaser.Types.Scenes.SceneType | Phaser.Types.Scenes.SceneType[];
  pixelArt?: boolean;
}

export class Renderer2D101 {
  readonly game: Phaser.Game;

  constructor(options: Renderer2DOptions) {
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: options.parent,
      width: options.width ?? 1280,
      height: options.height ?? 720,
      backgroundColor: options.background ?? "#0a0c0d",
      scene: options.scenes,
      pixelArt: options.pixelArt,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      input: { keyboard: false, mouse: false, touch: false, gamepad: false },
      audio: { noAudio: true },
    });
  }

  destroy() {
    this.game.destroy(true);
  }
}

export { Phaser };
