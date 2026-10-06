/**
 * Secondary labels describe a control only when they add information. Repeating the same word in a
 * small control makes the deck harder to scan without helping someone operate it.
 */
export function controllerHint(label: string, hint: string): string | undefined {
  const normalizedLabel = normalize(label);
  const normalizedHint = normalize(hint);
  if (!normalizedLabel || !normalizedHint || normalizedLabel.includes(normalizedHint)) return undefined;
  return hint;
}

/** Primary labels describe the current control task, rather than protocol assignment IDs. */
export function controllerTaskChrome({ connected, assigned, title }: {
  connected: boolean;
  assigned: boolean;
  title?: string;
}) {
  if (!connected) return { title: "Controller", status: "Waiting", sessionHint: "Open a game on the host" };
  if (!assigned) return { title: "Controller", status: "Waiting for controls", sessionHint: "Your controls will appear when a role opens" };
  return { title: title?.trim() || "Game controls", status: "Connected", sessionHint: "Controls are ready" };
}

/** A declared movement label is task content; it does not establish motion availability. */
export function controllerMotionCopy({ state, label }: {
  state: "idle" | "active" | "denied" | "unsupported";
  label?: string;
}) {
  if (state === "denied") return { buttonLabel: "Try motion again", description: "Motion permission was not granted. Touch controls remain available." };
  if (state === "unsupported") return { buttonLabel: "Check motion availability", description: "Motion is unavailable here. Touch controls remain available." };
  const movement = label?.trim() || "Motion control";
  if (state === "active") return { buttonLabel: "Set neutral", description: `${movement} is on. Touch controls remain available.` };
  return { buttonLabel: "Enable motion", description: `${movement} is optional. Touch controls remain available.` };
}

export function controllerConnectionCopy(state: "waiting" | "ready" | "reconnecting" | "unavailable" | "hostLost", title?: string) {
  switch (state) {
    case "waiting": return "You are connected. Waiting for an open role.";
    case "ready": return title?.trim() ? `${title.trim()} controls are ready.` : "Your controls are ready.";
    case "reconnecting": return "Connection interrupted. Trying to reconnect.";
    case "unavailable": return "Could not connect. Trying again.";
    case "hostLost": return "The game connection was lost. Trying to reconnect.";
  }
}

function normalize(value: string) {
  return value.toLocaleLowerCase().replaceAll(/[^\p{L}\p{N}]+/gu, "");
}
