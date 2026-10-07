import { invoke } from "@tauri-apps/api/core";
import { encodePairingTicket } from "@101/protocol";
import QRCode from "qrcode";
import type { CreatedSession, HubSettings, HubStatus, InstalledGame, ReplayCatalog, ReplayDeletion, StoredReplay } from "./types";
import "./style.css";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("101 Hub root is missing");

app.innerHTML = `
  <header class="topbar">
    <div><span class="eyebrow">LOCAL RUNTIME</span><h1>101 <b>HUB</b></h1></div>
    <span id="status-pill" class="pill waiting">STARTING</span>
  </header>
  <section class="hero panel">
    <div>
      <p class="kicker">ONE ROOM. ANY CONTROLLER.</p>
      <h2>Your private session coordinator.</h2>
      <p>Pair phones over your LAN, keep game packages and replays on this computer, and launch 101 without an account or cloud relay.</p>
      <div class="actions"><button id="open-launcher">OPEN 101</button><button id="refresh" class="secondary">REFRESH</button></div>
    </div>
    <dl class="metrics">
      <div><dt>SESSIONS</dt><dd id="session-count">0</dd></div>
      <div><dt>CONTROLLERS</dt><dd id="peer-count">0</dd></div>
      <div><dt>DISCOVERY</dt><dd id="mdns">—</dd></div>
    </dl>
  </section>
  <div id="notice" role="status" aria-live="polite"></div>
  <section class="grid">
    <article class="panel">
      <span class="eyebrow">PAIR A DEVICE</span><h3>New local session</h3>
      <label>Session name<input id="session-name" maxlength="32" value="PLAY101" /></label>
      <button id="create-session">CREATE PAIRING QR</button>
      <div id="pairing" class="pairing hidden"><canvas id="pair-qr"></canvas><code id="pair-code"></code><p id="pair-expiry"></p><button id="open-paired-session" class="secondary">OPEN THIS SESSION</button></div>
    </article>
    <article class="panel">
      <span class="eyebrow">NETWORK</span><h3>Reachable addresses</h3>
      <code id="endpoint">Starting…</code><ul id="addresses"></ul>
      <p class="muted">Control and realtime gameplay move to encrypted peer-to-peer WebRTC channels after signaling.</p>
    </article>
    <article class="panel">
      <span class="eyebrow">LOCAL LIBRARY</span><h3>Game packages</h3>
      <ul id="games" class="records"></ul>
      <details><summary>Import developer package</summary><label>Package folder<input id="package-path" placeholder="/absolute/path/to/game" /></label><button id="import-package" class="secondary">IMPORT</button></details>
    </article>
    <article class="panel replay-history">
      <span class="eyebrow">LOCAL HISTORY</span><h3 id="replay-heading" tabindex="-1">Replays</h3>
      <p class="muted">Saved replays become unavailable after seven days. Expired files are removed when the Hub next checks history. Up to 32 replays and 50 MiB, including files awaiting removal.</p>
      <p id="replay-status" role="status" aria-live="polite"></p>
      <ul id="replays" class="records"></ul>
      <button id="retry-replays" class="secondary">REFRESH HISTORY</button>
    </article>
    <article class="panel settings">
      <span class="eyebrow">HUB SETTINGS</span><h3>Private by default</h3>
      <label>Computer name<input id="host-name" maxlength="64" /></label>
      <label>Launcher URL<input id="launcher-url" inputmode="url" /></label>
      <label>Hub port<input id="hub-port" type="number" min="1024" max="65535" /></label>
      <label class="check"><input id="advertise" type="checkbox" /> Advertise on this LAN with mDNS</label>
      <button id="save-settings">SAVE & RESTART HUB</button>
    </article>
    <article class="panel">
      <span class="eyebrow">STORAGE</span><h3>On this computer</h3>
      <code id="data-dir">—</code>
      <p class="muted">Settings, installed packages, and deterministic replay data stay here. No telemetry service is configured.</p>
    </article>
  </section>
  <footer>101 Hub · protocol v2 · local-first / account-free</footer>
`;

const byId = <T extends HTMLElement>(id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
};

let status: HubStatus | undefined;
let settings: HubSettings | undefined;
let activeSession: { sessionId: string; hostToken: string } | undefined;

async function refresh(background = false) {
  // Background status polling must not replace a keyboard interaction in history.
  if (!background || (!replaySelection && !byId("replays").contains(document.activeElement))) void refreshReplayHistory();
  try {
    const [nextStatus, nextSettings, games] = await Promise.all([
      invoke<HubStatus>("hub_status"),
      invoke<HubSettings>("get_settings"),
      invoke<InstalledGame[]>("list_game_packages"),
    ]);
    status = nextStatus;
    settings = nextSettings;
    renderStatus(nextStatus);
    renderSettings(nextSettings);
    renderGames(games);
  } catch (error) {
    notify(error, true);
  }
}

function renderStatus(value: HubStatus) {
  const pill = byId("status-pill");
  pill.textContent = value.running ? "ONLINE · LOCAL" : "OFFLINE";
  pill.className = `pill ${value.running ? "online" : "offline"}`;
  byId("session-count").textContent = String(value.sessionCount);
  byId("peer-count").textContent = String(value.peerCount);
  byId("mdns").textContent = value.mdns ? "mDNS ON" : "MANUAL";
  byId("endpoint").textContent = value.endpoint || "Not listening";
  byId("data-dir").textContent = value.dataDirectory;
  byId("addresses").innerHTML = value.addresses.length
    ? value.addresses.map((address) => `<li>http://${escapeHtml(address)}:${settings?.port ?? 10101}</li>`).join("")
    : "<li>Loopback only</li>";
}

function renderSettings(value: HubSettings) {
  byId<HTMLInputElement>("host-name").value = value.hostName;
  byId<HTMLInputElement>("launcher-url").value = value.launcherUrl;
  byId<HTMLInputElement>("hub-port").value = String(value.port);
  byId<HTMLInputElement>("advertise").checked = value.advertiseMdns;
}

function renderGames(games: InstalledGame[]) {
  byId("games").innerHTML = games.length
    ? games.map((game) => `<li><b>${escapeHtml(game.name)}</b><span>v${escapeHtml(game.version)} · ${escapeHtml(game.renderer)}</span></li>`).join("")
    : "<li class=empty>No downloaded packages yet</li>";
}

let replayCatalog: ReplayCatalog | undefined;
let replaySelection: { id: string; generation: string } | "legacy" | undefined;
let replayIssued = false;
let replayEpoch = 0;
let replayDisposed = false;

function historyNotice(message: string) { byId("replay-status").textContent = message; }
function historyButton(label: string, action: () => void, disabled = replayIssued) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "secondary";
  button.textContent = label; button.disabled = disabled;
  button.addEventListener("click", action); return button;
}
function renderReplayHistory() {
  const list = byId("replays"); list.replaceChildren();
  byId<HTMLButtonElement>("retry-replays").disabled = replayIssued;
  const catalog = replayCatalog;
  if (!catalog) {
    const item = document.createElement("li"); item.className = "empty";
    item.textContent = replayIssued ? "Loading replay history…" : "Replay history is unavailable. Refresh to retry.";
    list.append(item); return;
  }
  if (catalog.state === "legacy-review") {
    const item = document.createElement("li");
    const copy = document.createElement("span");
    copy.textContent = "Existing replays need review. Applying retention uses their file dates; entries older than seven days will be removed. Nothing is opened or played automatically.";
    item.append(copy);
    if (replaySelection === "legacy") {
      item.append(historyButton(replayIssued ? "APPLYING…" : "CONFIRM RETENTION", () => void adoptReplayHistory()));
      item.append(historyButton("CANCEL", () => { replaySelection = undefined; renderReplayHistory(); byId("replay-heading").focus(); }));
    } else item.append(historyButton("REVIEW EXISTING REPLAYS", () => { replaySelection = "legacy"; renderReplayHistory(); list.querySelector<HTMLButtonElement>("button")?.focus(); }));
    list.append(item); return;
  }
  for (const replay of catalog.records) {
    const item = document.createElement("li");
    const title = document.createElement("b"); title.textContent = replay.gameId;
    const details = document.createElement("span");
    details.textContent = `${replay.seed} · ${formatBytes(replay.bytes)} · expires ${new Date(replay.expiresAt).toLocaleString()}`;
    item.append(title, details);
    const selected = replaySelection !== "legacy" && replaySelection?.id === replay.id && replaySelection.generation === replay.generation;
    if (selected) {
      const warning = document.createElement("span"); warning.textContent = "Delete this replay from this computer?"; item.append(warning);
      const confirm = historyButton(replayIssued ? "DELETING…" : "CONFIRM DELETE", () => void deleteSelectedReplay(replay));
      confirm.dataset.confirmDelete = "true"; item.append(confirm);
      item.append(historyButton("CANCEL", () => { replaySelection = undefined; renderReplayHistory(); list.querySelector<HTMLButtonElement>("button")?.focus(); }));
    } else {
      const button = historyButton("DELETE", () => { replaySelection = { id: replay.id, generation: replay.generation }; renderReplayHistory(); list.querySelector<HTMLButtonElement>("[data-confirm-delete]")?.focus(); });
      button.setAttribute("aria-label", `Delete replay for ${replay.gameId}`); item.append(button);
    }
    list.append(item);
  }
  if (!catalog.records.length) {
    const item = document.createElement("li"); item.className = "empty"; item.textContent = "No replay data yet"; list.append(item);
  }
}
async function refreshReplayHistory() {
  if (replayIssued || replayDisposed) return;
  replayIssued = true; const epoch = ++replayEpoch; renderReplayHistory();
  try {
    const next = await invoke<ReplayCatalog>("list_replays");
    if (replayDisposed || replayEpoch !== epoch) return;
    replayCatalog = next;
    const selected = replaySelection;
    if (selected !== "legacy" && selected && !next.records.some((r) => r.id === selected.id && r.generation === selected.generation)) replaySelection = undefined;
    historyNotice(next.state === "legacy-review" ? "Review the retention policy before opening existing replay data." : `${next.records.length} saved replays · ${formatBytes(next.totalBytes)} on this computer`);
  } catch {
    if (!replayDisposed && replayEpoch === epoch) { replayCatalog = undefined; historyNotice("Replay history could not be loaded. Refresh to retry; if local recovery is needed, restart the Hub afterward."); }
  } finally {
    if (!replayDisposed && replayEpoch === epoch) { replayIssued = false; renderReplayHistory(); }
  }
}
async function deleteSelectedReplay(replay: StoredReplay) {
  const selected = replaySelection;
  if (replayIssued || replayDisposed || !selected || selected === "legacy" || selected.id !== replay.id || selected.generation !== replay.generation) return;
  replayIssued = true; const epoch = ++replayEpoch; renderReplayHistory();
  try {
    const result = await invoke<ReplayDeletion>("delete_replay", { id: replay.id, generation: replay.generation });
    if (replayDisposed || replayEpoch !== epoch) return;
    if (result.state === "deleted" || result.state === "not-found") {
      replayCatalog = replayCatalog && { ...replayCatalog, records: replayCatalog.records.filter((r) => r.id !== replay.id || r.generation !== replay.generation) };
      replaySelection = undefined; historyNotice(result.state === "deleted" ? "Replay deleted from this computer." : "This replay is no longer saved.");
    } else if (result.state === "conflict") { replaySelection = undefined; historyNotice("This replay changed. Refresh history before choosing it again."); }
    else historyNotice("Removal is incomplete. Refresh history to retry cleanup; the replay cannot be opened.");
  } catch { if (!replayDisposed && replayEpoch === epoch) historyNotice("Deletion could not be confirmed. Refresh history to check its current state."); }
  finally {
    if (!replayDisposed && replayEpoch === epoch) { replayIssued = false; renderReplayHistory(); byId("replay-heading").focus(); }
  }
}
async function adoptReplayHistory() {
  if (replayIssued || replayDisposed || replaySelection !== "legacy") return;
  replayIssued = true; const epoch = ++replayEpoch; renderReplayHistory();
  try {
    const next = await invoke<ReplayCatalog>("review_replay_retention");
    if (replayDisposed || replayEpoch !== epoch) return;
    replayCatalog = next; replaySelection = undefined; historyNotice("Replay retention applied. Expired entries are unavailable and removed when cleanup succeeds.");
  } catch { if (!replayDisposed && replayEpoch === epoch) historyNotice("Retention could not be applied. Review local files and retry; no successful removal is claimed."); }
  finally {
    if (!replayDisposed && replayEpoch === epoch) { replayIssued = false; renderReplayHistory(); byId("replay-heading").focus(); }
  }
}

async function createSession() {
  if (!status?.running) return notify("The Hub is not listening", true);
  const name = byId<HTMLInputElement>("session-name").value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
  if (name.length < 4) return notify("Use at least four letters or numbers", true);
  try {
    const endpoint = status.addresses[0] ? `http://${status.addresses[0]}:${settings?.port ?? 10101}` : status.endpoint;
    const created = await fetch(`${status.endpoint}/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: name, hostName: settings?.hostName, endpoint }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(`Session creation failed (${response.status})`);
      return response.json() as Promise<CreatedSession>;
    });
    const code = encodePairingTicket(created.ticket);
    await QRCode.toCanvas(byId<HTMLCanvasElement>("pair-qr"), code, { width: 220, margin: 2, color: { dark: "#061018", light: "#f2fffd" } });
    byId("pair-code").textContent = code;
    byId("pair-expiry").textContent = `Expires ${new Date(created.ticket.expiresAt).toLocaleTimeString()}`;
    activeSession = { sessionId: created.ticket.sessionId, hostToken: created.hostToken };
    byId("pairing").classList.remove("hidden");
    notify("Pairing invitation created locally");
    await refresh();
  } catch (error) { notify(error, true); }
}

async function saveSettings() {
  const next: HubSettings = {
    hostName: byId<HTMLInputElement>("host-name").value.trim(),
    launcherUrl: byId<HTMLInputElement>("launcher-url").value.trim(),
    port: Number(byId<HTMLInputElement>("hub-port").value),
    advertiseMdns: byId<HTMLInputElement>("advertise").checked,
  };
  try {
    await invoke("update_settings", { settings: next });
    notify("Hub settings saved; listener restarted");
    await refresh();
  } catch (error) { notify(error, true); }
}

async function importPackage() {
  const path = byId<HTMLInputElement>("package-path").value.trim();
  if (!path) return notify("Enter an absolute package folder", true);
  try {
    const game = await invoke<InstalledGame>("register_game_package", { path });
    notify(`${game.name} installed locally`);
    await refresh();
  } catch (error) { notify(error, true); }
}

function notify(value: unknown, error = false) {
  const message = value instanceof Error ? value.message : String(value);
  const notice = byId("notice");
  notice.textContent = message;
  notice.className = error ? "error" : "success";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character);
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`; }

byId("retry-replays").addEventListener("click", () => void refreshReplayHistory());
window.addEventListener("pagehide", () => { replayDisposed = true; replayEpoch += 1; });

byId("refresh").addEventListener("click", () => void refresh());
byId("create-session").addEventListener("click", () => void createSession());
byId("save-settings").addEventListener("click", () => void saveSettings());
byId("import-package").addEventListener("click", () => void importPackage());
byId("open-launcher").addEventListener("click", () => void invoke("open_launcher").catch((error) => notify(error, true)));
byId("open-paired-session").addEventListener("click", () => {
  if (activeSession) void invoke("open_launcher", activeSession).catch((error) => notify(error, true));
});

void refresh();
window.setInterval(() => void refresh(true), 3_000);
