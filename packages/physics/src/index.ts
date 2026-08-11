import RAPIER from "@dimforge/rapier2d-compat";

export interface Vector2_101 {
  x: number;
  y: number;
}

export interface BodyOptions {
  type?: "dynamic" | "fixed" | "kinematic";
  x?: number;
  y?: number;
  rotation?: number;
  angularVelocity?: number;
  gravityScale?: number;
  linearDamping?: number;
  angularDamping?: number;
}

export interface ColliderOptions {
  friction?: number;
  restitution?: number;
  density?: number;
  sensor?: boolean;
}

export type ColliderShape =
  | { type: "ball"; radius: number }
  | { type: "box"; width: number; height: number };

export interface PhysicsBody101 {
  readonly id: number;
}

export interface PhysicsCollider101 {
  readonly id: number;
}

export interface BodyState101 {
  position: Vector2_101;
  rotation: number;
  velocity: Vector2_101;
  angularVelocity: number;
  sleeping: boolean;
}

export interface RayHit101 {
  colliderId: number;
  timeOfImpact: number;
}

export class Physics101 {
  private world?: RAPIER.World;
  private readonly bodies = new Map<number, RAPIER.RigidBody>();
  private readonly colliders = new Map<number, RAPIER.Collider>();
  private bodyId = 0;
  private colliderId = 0;

  async initialize(gravity: Vector2_101 = { x: 0, y: 9.81 }) {
    this.destroy();
    await RAPIER.init();
    this.world = new RAPIER.World(sanitizeVector(gravity));
  }

  createBody(options: BodyOptions = {}): PhysicsBody101 {
    const world = this.requireWorld();
    const descriptor = options.type === "fixed"
      ? RAPIER.RigidBodyDesc.fixed()
      : options.type === "kinematic"
        ? RAPIER.RigidBodyDesc.kinematicPositionBased()
        : RAPIER.RigidBodyDesc.dynamic();
    descriptor.setTranslation(finite(options.x), finite(options.y));
    descriptor.setRotation(finite(options.rotation));
    descriptor.setAngvel(finite(options.angularVelocity));
    descriptor.setGravityScale(finite(options.gravityScale, 1));
    descriptor.setLinearDamping(clamp(options.linearDamping ?? 0, 0, 100));
    descriptor.setAngularDamping(clamp(options.angularDamping ?? 0, 0, 100));
    const id = ++this.bodyId;
    this.bodies.set(id, world.createRigidBody(descriptor));
    return Object.freeze({ id });
  }

  createCollider(body: PhysicsBody101, shape: ColliderShape, options: ColliderOptions = {}): PhysicsCollider101 {
    const descriptor = shape.type === "ball"
      ? RAPIER.ColliderDesc.ball(Math.max(.001, finite(shape.radius, .5)))
      : RAPIER.ColliderDesc.cuboid(Math.max(.001, finite(shape.width, 1)) / 2, Math.max(.001, finite(shape.height, 1)) / 2);
    descriptor.setFriction(clamp(options.friction ?? .5, 0, 10));
    descriptor.setRestitution(clamp(options.restitution ?? 0, 0, 1));
    descriptor.setDensity(Math.max(.001, finite(options.density, 1)));
    descriptor.setSensor(options.sensor ?? false);
    const collider = this.requireWorld().createCollider(descriptor, this.requireBody(body));
    const id = ++this.colliderId;
    this.colliders.set(id, collider);
    return Object.freeze({ id });
  }

  setGravity(x: number, y: number) {
    const world = this.requireWorld();
    world.gravity.x = finite(x);
    world.gravity.y = finite(y);
    this.bodies.forEach((body) => body.wakeUp());
  }

  gravity(): Vector2_101 {
    const gravity = this.requireWorld().gravity;
    return { x: gravity.x, y: gravity.y };
  }

  applyImpulse(body: PhysicsBody101, x: number, y: number) {
    this.requireBody(body).applyImpulse({ x: finite(x), y: finite(y) }, true);
  }

  setVelocity(body: PhysicsBody101, x: number, y: number) {
    this.requireBody(body).setLinvel({ x: finite(x), y: finite(y) }, true);
  }

  setAngularVelocity(body: PhysicsBody101, value: number) {
    this.requireBody(body).setAngvel(finite(value), true);
  }

  setTransform(body: PhysicsBody101, x: number, y: number, rotation?: number) {
    const resolved = this.requireBody(body);
    resolved.setTranslation({ x: finite(x), y: finite(y) }, true);
    if (rotation !== undefined) resolved.setRotation(finite(rotation), true);
  }

  bodyState(body: PhysicsBody101): BodyState101 {
    const resolved = this.requireBody(body);
    const position = resolved.translation();
    const velocity = resolved.linvel();
    return {
      position: { x: position.x, y: position.y },
      rotation: resolved.rotation(),
      velocity: { x: velocity.x, y: velocity.y },
      angularVelocity: resolved.angvel(),
      sleeping: resolved.isSleeping(),
    };
  }

  raycast(origin: Vector2_101, direction: Vector2_101, maxToi = 100): RayHit101 | undefined {
    const hit = this.requireWorld().castRay(new RAPIER.Ray(sanitizeVector(origin), sanitizeVector(direction)), Math.max(0, finite(maxToi, 100)), true);
    if (!hit) return undefined;
    const colliderId = [...this.colliders.entries()].find(([, collider]) => collider.handle === hit.collider.handle)?.[0];
    return colliderId ? { colliderId, timeOfImpact: hit.timeOfImpact } : undefined;
  }

  removeBody(body: PhysicsBody101) {
    const resolved = this.bodies.get(body.id);
    if (!resolved || !this.world) return false;
    for (const [id, collider] of this.colliders) {
      if (collider.parent()?.handle === resolved.handle) this.colliders.delete(id);
    }
    this.world.removeRigidBody(resolved);
    this.bodies.delete(body.id);
    return true;
  }

  step(deltaSeconds = 1 / 60) {
    const world = this.requireWorld();
    let remaining = clamp(deltaSeconds, 0, .1);
    while (remaining > 0) {
      const step = Math.min(remaining, 1 / 60);
      world.timestep = step;
      world.step();
      remaining -= step;
    }
  }

  destroy() {
    this.world?.free();
    this.world = undefined;
    this.bodies.clear();
    this.colliders.clear();
  }

  private requireBody(body: PhysicsBody101) {
    const resolved = this.bodies.get(body.id);
    if (!resolved) throw new Error(`Unknown 101 physics body: ${body.id}`);
    return resolved;
  }

  private requireWorld() {
    if (!this.world) throw new Error("Call Physics101.initialize() first");
    return this.world;
  }
}

function sanitizeVector(value: Vector2_101): Vector2_101 {
  return { x: finite(value.x), y: finite(value.y) };
}

function finite(value: number | undefined, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
