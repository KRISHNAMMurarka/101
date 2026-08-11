import RAPIER from "@dimforge/rapier2d-compat";

export interface BodyOptions {
  type?: "dynamic" | "fixed" | "kinematic";
  x?: number;
  y?: number;
}

export class Physics101 {
  private world?: RAPIER.World;

  async initialize(gravity = { x: 0, y: 9.81 }) {
    await RAPIER.init();
    this.world = new RAPIER.World(gravity);
  }

  createBody(options: BodyOptions = {}) {
    const world = this.requireWorld();
    const descriptor = options.type === "fixed"
      ? RAPIER.RigidBodyDesc.fixed()
      : options.type === "kinematic"
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic();
    descriptor.setTranslation(options.x ?? 0, options.y ?? 0);
    return world.createRigidBody(descriptor);
  }

  createCollider(
    body: RAPIER.RigidBody,
    shape: { type: "ball"; radius: number } | { type: "box"; width: number; height: number },
  ) {
    const descriptor = shape.type === "ball"
      ? RAPIER.ColliderDesc.ball(shape.radius)
      : RAPIER.ColliderDesc.cuboid(shape.width / 2, shape.height / 2);
    return this.requireWorld().createCollider(descriptor, body);
  }

  applyImpulse(body: RAPIER.RigidBody, x: number, y: number) {
    body.applyImpulse({ x, y }, true);
  }

  setVelocity(body: RAPIER.RigidBody, x: number, y: number) {
    body.setLinvel({ x, y }, true);
  }

  raycast(origin: RAPIER.Vector, direction: RAPIER.Vector, maxToi = 100) {
    return this.requireWorld().castRay(new RAPIER.Ray(origin, direction), maxToi, true);
  }

  removeBody(body: RAPIER.RigidBody) {
    this.requireWorld().removeRigidBody(body);
  }

  step(deltaSeconds = 1 / 60) {
    const world = this.requireWorld();
    world.timestep = deltaSeconds;
    world.step();
  }

  private requireWorld() {
    if (!this.world) throw new Error("Call Physics101.initialize() first");
    return this.world;
  }
}
