import type { InputFrame } from "@101/input";
import {
  PROTOCOL_VERSION,
  type ControllerLayout,
  type DeviceCapabilities,
  type LinkMessage,
  type LinkTransport,
} from "@101/protocol";

export interface ConnectedDevice {
  id: string;
  label: string;
  capabilities: DeviceCapabilities;
  connectedAt: number;
  lastSeenAt: number;
}

export interface SessionRole {
  id: string;
  label: string;
  playerId: string;
  layout: ControllerLayout;
  requiredCapabilities?: readonly (keyof DeviceCapabilities)[];
  preferredCapabilities?: readonly (keyof DeviceCapabilities)[];
}

export interface RoleAssignment {
  deviceId: string;
  gameId: string;
  roleId: string;
  roleLabel: string;
  playerId: string;
  assignedAt: number;
}

export interface SessionSnapshot {
  code: string;
  gameId: string;
  revision: number;
  devices: ConnectedDevice[];
  assignments: RoleAssignment[];
  openRoles: SessionRole[];
}

export class LocalSession {
  readonly devices = new Map<string, ConnectedDevice>();
  readonly assignments = new Map<string, RoleAssignment>();
  readonly code: string;
  readonly createdAt: number;
  private roles: SessionRole[] = [];
  private readonly pinnedRoles = new Map<string, string>();
  private currentGameId = "launcher";
  private currentRevision = 0;

  constructor(code: string = createSessionCode(), createdAt = Date.now()) {
    this.code = code;
    this.createdAt = createdAt;
  }

  get gameId() {
    return this.currentGameId;
  }

  get revision() {
    return this.currentRevision;
  }

  configureGame(gameId: string, roles: readonly SessionRole[]) {
    validateRoles(roles);
    this.currentGameId = gameId;
    this.roles = roles.map((role) => ({ ...role, layout: cloneLayout(role.layout) }));
    const roleIds = new Set(this.roles.map((role) => role.id));
    for (const roleId of this.pinnedRoles.keys()) {
      if (!roleIds.has(roleId)) this.pinnedRoles.delete(roleId);
    }
    this.currentRevision += 1;
    this.reconcile();
  }

  register(device: Omit<ConnectedDevice, "connectedAt"> & { connectedAt?: number }) {
    const previous = this.devices.get(device.id);
    this.devices.set(device.id, {
      id: device.id,
      label: device.label,
      capabilities: { ...device.capabilities },
      connectedAt: previous?.connectedAt ?? device.connectedAt ?? device.lastSeenAt,
      lastSeenAt: device.lastSeenAt,
    });
    this.reconcile();
    return this.assignments.get(device.id);
  }

  remove(deviceId: string) {
    const removed = this.devices.delete(deviceId);
    this.assignments.delete(deviceId);
    for (const [roleId, pinnedDeviceId] of this.pinnedRoles) {
      if (pinnedDeviceId === deviceId) this.pinnedRoles.delete(roleId);
    }
    if (removed) this.reconcile();
    return removed;
  }

  expire(before: number) {
    const expired: string[] = [];
    for (const device of this.devices.values()) {
      if (device.lastSeenAt >= before) continue;
      expired.push(device.id);
      this.devices.delete(device.id);
      this.assignments.delete(device.id);
      for (const [roleId, pinnedDeviceId] of this.pinnedRoles) {
        if (pinnedDeviceId === device.id) this.pinnedRoles.delete(roleId);
      }
    }
    if (expired.length) this.reconcile();
    return expired;
  }

  assign(deviceId: string, roleId: string) {
    const device = this.devices.get(deviceId);
    const role = this.roles.find((candidate) => candidate.id === roleId);
    if (!device || !role || !isRoleCompatible(role, device.capabilities)) return false;
    this.pinnedRoles.set(roleId, deviceId);
    this.reconcile();
    return true;
  }

  compatibleDevices(capability: keyof DeviceCapabilities) {
    return [...this.devices.values()].filter(
      (device) => device.capabilities[capability] === true,
    );
  }

  role(roleId: string) {
    return this.roles.find((role) => role.id === roleId);
  }

  assignmentForDevice(deviceId: string) {
    return this.assignments.get(deviceId);
  }

  assignmentForRole(roleId: string) {
    return [...this.assignments.values()].find((assignment) => assignment.roleId === roleId);
  }

  snapshot(): SessionSnapshot {
    const occupied = new Set([...this.assignments.values()].map((assignment) => assignment.roleId));
    return {
      code: this.code,
      gameId: this.currentGameId,
      revision: this.currentRevision,
      devices: [...this.devices.values()].map((device) => ({ ...device, capabilities: { ...device.capabilities } })),
      assignments: [...this.assignments.values()].map((assignment) => ({ ...assignment })),
      openRoles: this.roles.filter((role) => !occupied.has(role.id)).map((role) => ({ ...role, layout: cloneLayout(role.layout) })),
    };
  }

  private reconcile() {
    const rolesById = new Map(this.roles.map((role) => [role.id, role]));
    const previous = new Map(this.assignments);
    this.assignments.clear();
    const occupiedRoles = new Set<string>();
    const occupiedDevices = new Set<string>();
    for (const [roleId, deviceId] of this.pinnedRoles) {
      const role = rolesById.get(roleId);
      const device = this.devices.get(deviceId);
      if (!role || !device || !isRoleCompatible(role, device.capabilities)) continue;
      occupiedRoles.add(role.id);
      occupiedDevices.add(deviceId);
      const old = previous.get(deviceId);
      this.assignments.set(deviceId, createAssignment(deviceId, this.currentGameId, role, old?.roleId === role.id ? old.assignedAt : Date.now()));
    }

    const unassigned = [...this.devices.values()].filter((device) => !occupiedDevices.has(device.id));
    for (const role of this.roles) {
      if (occupiedRoles.has(role.id)) continue;
      const candidates = unassigned
        .filter((device) => isRoleCompatible(role, device.capabilities))
        .sort((a, b) => capabilityScore(role, b.capabilities) - capabilityScore(role, a.capabilities)
          || Number(previous.get(b.id)?.roleId === role.id) - Number(previous.get(a.id)?.roleId === role.id)
          || a.connectedAt - b.connectedAt
          || a.id.localeCompare(b.id));
      const device = candidates[0];
      if (!device) continue;
      const old = previous.get(device.id);
      this.assignments.set(device.id, createAssignment(device.id, this.currentGameId, role, old?.roleId === role.id ? old.assignedAt : Date.now()));
      occupiedRoles.add(role.id);
      unassigned.splice(unassigned.indexOf(device), 1);
    }
  }
}

export interface SessionHostOptions {
  gameId: string;
  roles: readonly SessionRole[];
  transport: LinkTransport;
  session?: LocalSession;
  onFrame(frame: InputFrame): void;
  onChange?(snapshot: SessionSnapshot): void;
  now?: () => number;
  deviceTimeoutMs?: number;
}

export class SessionHost {
  readonly session: LocalSession;
  private readonly transport: LinkTransport;
  private readonly onFrame: (frame: InputFrame) => void;
  private readonly onChange?: (snapshot: SessionSnapshot) => void;
  private readonly now: () => number;
  private readonly deviceTimeoutMs: number;
  private removeListener?: () => void;
  private expiryTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(options: SessionHostOptions) {
    this.transport = options.transport;
    this.session = options.session ?? new LocalSession();
    this.onFrame = options.onFrame;
    this.onChange = options.onChange;
    this.now = options.now ?? (() => Date.now());
    this.deviceTimeoutMs = options.deviceTimeoutMs ?? 6_000;
    this.session.configureGame(options.gameId, options.roles);
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.removeListener = this.transport.onMessage((message) => this.receive(message));
    await this.transport.connect();
    this.expiryTimer = setInterval(() => {
      const expired = this.session.expire(this.now() - this.deviceTimeoutMs);
      if (expired.length) this.notifyChange();
    }, Math.min(2_000, this.deviceTimeoutMs));
    this.notifyChange();
  }

  async stop() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = undefined;
    this.removeListener?.();
    this.removeListener = undefined;
    this.started = false;
    await this.transport.disconnect();
  }

  setGame(gameId: string, roles: readonly SessionRole[]) {
    this.session.configureGame(gameId, roles);
    this.syncAssignments();
    this.notifyChange();
  }

  sendControllerState(
    roleId: string,
    values: Record<string, string | number | boolean>,
    options: { message?: string; tone?: "normal" | "warning" | "critical" } = {},
  ) {
    const assignment = this.session.assignmentForRole(roleId);
    if (!assignment) return false;
    this.transport.sendReliable({
      type: "controller.state",
      deviceId: assignment.deviceId,
      values,
      ...options,
    });
    return true;
  }

  haptic(roleId: string, pattern: "tap" | "impact" | "warning") {
    const assignment = this.session.assignmentForRole(roleId);
    if (!assignment) return false;
    this.transport.sendReliable({ type: "haptic", deviceId: assignment.deviceId, pattern });
    return true;
  }

  private receive(message: LinkMessage) {
    if (message.channel === "control" && message.payload.type === "hello") {
      const hello = message.payload;
      if (hello.version !== PROTOCOL_VERSION) return;
      this.session.register({
        id: hello.deviceId,
        label: hello.device,
        capabilities: hello.capabilities,
        lastSeenAt: this.now(),
      });
      this.syncAssignments();
      this.notifyChange();
      return;
    }
    if (message.channel !== "realtime") return;
    const assignment = this.session.assignmentForDevice(message.payload.deviceId);
    if (!assignment) return;
    this.onFrame({
      ...message.payload,
      deviceId: assignment.deviceId,
      playerId: assignment.playerId,
    });
  }

  private syncAssignments() {
    for (const assignment of this.session.assignments.values()) {
      const role = this.session.role(assignment.roleId);
      if (!role) continue;
      this.transport.sendReliable({
        type: "player.assign",
        deviceId: assignment.deviceId,
        playerId: assignment.playerId,
        role: assignment.roleId,
        gameId: assignment.gameId,
      });
      this.transport.sendReliable({
        type: "controller.configure",
        deviceId: assignment.deviceId,
        gameId: assignment.gameId,
        role: assignment.roleId,
        revision: this.session.revision,
        layout: cloneLayout(role.layout),
      });
    }
  }

  private notifyChange() {
    this.onChange?.(this.session.snapshot());
  }
}

export function isRoleCompatible(role: SessionRole, capabilities: DeviceCapabilities) {
  return (role.requiredCapabilities ?? []).every((capability) => capabilities[capability] === true);
}

export function createSessionCode(random = Math.random) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 6 }, () =>
    alphabet[Math.floor(random() * alphabet.length)],
  ).join("");
}

function capabilityScore(role: SessionRole, capabilities: DeviceCapabilities) {
  return (role.preferredCapabilities ?? []).reduce(
    (score, capability) => score + Number(capabilities[capability] === true),
    0,
  );
}

function createAssignment(deviceId: string, gameId: string, role: SessionRole, assignedAt: number): RoleAssignment {
  return {
    deviceId,
    gameId,
    roleId: role.id,
    roleLabel: role.label,
    playerId: role.playerId,
    assignedAt,
  };
}

function cloneLayout(layout: ControllerLayout): ControllerLayout {
  return {
    ...layout,
    motion: layout.motion ? { ...layout.motion } : undefined,
    layout: layout.layout.map((element) => ({ ...element })),
  };
}

function validateRoles(roles: readonly SessionRole[]) {
  const ids = new Set<string>();
  const players = new Set<string>();
  for (const role of roles) {
    if (!role.id || !role.playerId || !role.label) throw new Error("Session roles require id, playerId, and label");
    if (ids.has(role.id)) throw new Error(`Duplicate session role: ${role.id}`);
    if (players.has(role.playerId)) throw new Error(`Duplicate session player: ${role.playerId}`);
    ids.add(role.id);
    players.add(role.playerId);
  }
}
