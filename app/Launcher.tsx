"use client";

import Link from "next/link";
import QRCode from "qrcode";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { getBrowserHostTransport, type BrowserPairingInfo } from "./lib/browser-link";
import type { InputSource } from "@101/input";

import { GamePoster } from "./components/GamePoster";
import { Icon } from "./components/Icon";
import { useLocalDevice } from "./lib/local-capabilities";
import {
  CATALOG_INPUT_LABELS,
  CATALOG_INPUT_PROFILES,
  buildCatalogSearchIndex,
  filterCatalog,
  planCatalogWindow,
  type CatalogInputFilter,
  type CatalogWindowPlan,
  type LauncherCatalogEntry,
} from "./lib/catalog";
const INITIAL_CATALOG_ITEMS = 12;
const INITIAL_CATALOG_COLUMNS = 3;
const INITIAL_CATALOG_ROW_HEIGHT = 500;

export default function Launcher({
  games,
  benchmarkMode = false,
}: {
  games: readonly LauncherCatalogEntry[];
  benchmarkMode?: boolean;
}) {
  const [pairingOpen, setPairingOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [inputFilter, setInputFilter] = useState<CatalogInputFilter>("all");
  const [requestedPageStart, setRequestedPageStart] = useState<number | null>(null);
  const pageFocusTargetRef = useRef<HTMLElement>(null);
  const pageFocusScrollTopRef = useRef<number | null>(null);
  const pageFocusScrollSettledRef = useRef(false);
  const pageFocusSettleFrameRef = useRef<number | null>(null);
  const { sources: localSources } = useLocalDevice();
  const instanceId = useId();
  const generatedSessionId = `101${instanceId.replace(/[^a-z0-9]/gi, "").toUpperCase()}LAB`.slice(0, 6).padEnd(6, "X");
  const [sessionId] = useState(() => {
    if (typeof window === "undefined") return generatedSessionId;
    const requested = new URLSearchParams(window.location.search).get("session")?.trim();
    return requested && /^[A-Z0-9-]{4,128}$/i.test(requested) ? requested : generatedSessionId;
  });


  // The server passes the complete catalog through the production server/client boundary. The
  // initial window below remains exactly twelve cards on both sides of hydration.
  const catalog = games;
  const deferredQuery = useDeferredValue(query);
  // Built once per catalog rather than shipped with it: the text is derived from fields the entry
  // already carries, and sending it too made it 28% of every entry.
  const searchIndex = useMemo(() => buildCatalogSearchIndex(catalog), [catalog]);
  const filteredCatalog = useMemo(
    () => filterCatalog(catalog, { query: deferredQuery, input: inputFilter, searchIndex }),
    [catalog, deferredQuery, inputFilter, searchIndex],
  );
  const { anchorIndex, gridRef, windowPlan } = useCatalogWindow(filteredCatalog.length, true);
  const requestedPage = useMemo(
    () => requestedPageStart === null
      ? null
      : planCatalogPage(filteredCatalog.length, requestedPageStart),
    [filteredCatalog.length, requestedPageStart],
  );
  const renderWindow = requestedPage ?? windowPlan;
  const visibleCatalog = useMemo(
    () => filteredCatalog.slice(renderWindow.startIndex, renderWindow.endIndex),
    [filteredCatalog, renderWindow.endIndex, renderWindow.startIndex],
  );
  const currentPage = planCatalogPage(
    filteredCatalog.length,
    requestedPage?.startIndex ?? anchorIndex,
  );
  const pageNumber = Math.floor(currentPage.startIndex / INITIAL_CATALOG_ITEMS) + 1;
  const pageCount = Math.ceil(filteredCatalog.length / INITIAL_CATALOG_ITEMS);

  useEffect(() => {
    if (requestedPageStart === null) return;
    const focusTarget = pageFocusTargetRef.current;
    if (!focusTarget) return;
    pageFocusScrollSettledRef.current = false;
    pageFocusScrollTopRef.current = null;
    pageFocusTargetRef.current?.focus({ preventScroll: true });
    focusTarget.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
    pageFocusSettleFrameRef.current = window.requestAnimationFrame(() => {
      pageFocusSettleFrameRef.current = window.requestAnimationFrame(() => {
        pageFocusScrollTopRef.current = window.scrollY;
        pageFocusScrollSettledRef.current = true;
        pageFocusSettleFrameRef.current = null;
      });
    });
    return () => {
      if (pageFocusSettleFrameRef.current !== null) {
        window.cancelAnimationFrame(pageFocusSettleFrameRef.current);
        pageFocusSettleFrameRef.current = null;
      }
    };
  }, [renderWindow.startIndex, requestedPageStart]);

  // Paging is stable while a player reads or tabs through the mounted slice. The first deliberate
  // scroll gesture returns control to whole-page windowing; focus-induced scrolling does not make
  // the pager chase itself down the catalog.
  useEffect(() => {
    if (requestedPageStart === null) return;
    const releasePage = () => setRequestedPageStart(null);
    const releasePageFromScroll = () => {
      if (!pageFocusScrollSettledRef.current) return;
      const focusScrollTop = pageFocusScrollTopRef.current;
      if (focusScrollTop !== null && Math.abs(window.scrollY - focusScrollTop) < 1) return;
      pageFocusScrollTopRef.current = null;
      releasePage();
    };
    const releasePageFromKey = (event: KeyboardEvent) => {
      if (![" ", "ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", "Spacebar"].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest(".catalog-pager")) return;
      releasePage();
    };
    window.addEventListener("wheel", releasePage, { passive: true });
    window.addEventListener("touchmove", releasePage, { passive: true });
    window.addEventListener("scroll", releasePageFromScroll, { passive: true });
    window.addEventListener("keydown", releasePageFromKey);
    return () => {
      window.removeEventListener("wheel", releasePage);
      window.removeEventListener("touchmove", releasePage);
      window.removeEventListener("scroll", releasePageFromScroll);
      window.removeEventListener("keydown", releasePageFromKey);
      pageFocusScrollTopRef.current = null;
    };
  }, [requestedPageStart]);
  const activeProfile = CATALOG_INPUT_PROFILES.find((profile) => profile.id === inputFilter);
  const hasCatalogFilter = deferredQuery.trim().length > 0 || inputFilter !== "all";
  const hasCatalogSelection = query.trim().length > 0 || inputFilter !== "all";
  const catalogNoun = benchmarkMode ? "benchmark entries" : "games";
  const resultCountCopy = hasCatalogFilter
    ? `${filteredCatalog.length} of ${catalog.length} ${catalogNoun} match${activeProfile ? ` · ${activeProfile.label}` : ""}`
    : `${catalog.length} ${catalogNoun} available`;

  const resetCatalog = () => {
    setQuery("");
    setInputFilter("all");
    setRequestedPageStart(null);
  };

  const requestCatalogPage = (startIndex: number) => {
    pageFocusScrollSettledRef.current = false;
    setRequestedPageStart(planCatalogPage(filteredCatalog.length, startIndex).startIndex);
  };

  const catalogPager = filteredCatalog.length > INITIAL_CATALOG_ITEMS ? (
    <div className="catalog-pager" role="presentation">
      <div className="catalog-pager-controls" role="group" aria-label="Result page controls">
        <button
          type="button"
          aria-label="Previous result page"
          disabled={currentPage.startIndex === 0}
          onClick={() => requestCatalogPage(currentPage.startIndex - INITIAL_CATALOG_ITEMS)}
        >
          ← Previous
        </button>
        <span className="catalog-page-status" aria-live="polite" aria-atomic="true">
          {currentPage.startIndex + 1}–{currentPage.endIndex} of {filteredCatalog.length} · Page {pageNumber} of {pageCount}
        </span>
        <button
          type="button"
          aria-label="Next result page"
          disabled={currentPage.endIndex >= filteredCatalog.length}
          onClick={() => requestCatalogPage(currentPage.startIndex + INITIAL_CATALOG_ITEMS)}
        >
          Next →
        </button>
      </div>
    </div>
  ) : null;
  const catalogKeyboardPager = filteredCatalog.length > INITIAL_CATALOG_ITEMS ? (
    <button
      className="catalog-pager-forward"
      type="button"
      onClick={() => requestCatalogPage(
        currentPage.endIndex < filteredCatalog.length
          ? currentPage.startIndex + INITIAL_CATALOG_ITEMS
          : currentPage.startIndex - INITIAL_CATALOG_ITEMS,
      )}
    >
      {currentPage.endIndex < filteredCatalog.length
        ? `Continue to results ${currentPage.endIndex + 1}–${Math.min(filteredCatalog.length, currentPage.endIndex + INITIAL_CATALOG_ITEMS)}`
        : `Return to results ${Math.max(1, currentPage.startIndex - INITIAL_CATALOG_ITEMS + 1)}–${currentPage.startIndex}`}
    </button>
  ) : null;

  return (
    <main className="site-shell">

          <section className="hero">
            <div className="hero-copy">
              <p className="eyebrow">One system · Every controller</p>
              <h1>Anything can be<br />a controller.</h1>
              <p className="hero-intro">
                101 turns the devices around you into controllers—then lets every game understand them.
              </p>
              <div className="hero-actions">
                <Link className="primary-button" href="/games/slashstorm">
                  Play Slashstorm <Icon name="arrow" size={16} />
                </Link>
                <button className="text-button" onClick={() => setPairingOpen(true)}>
                  Try a second-screen controller
                </button>
              </div>
            </div>
          </section>

          <section className="signal-strip" aria-label="Supported input categories">
            {["Keyboard", "Gamepad", "Phone motion", "Camera", "Watch", "HID / BLE", "Future input"].map((item, index) => (
              <span key={item}><b>{String(index + 1).padStart(2, "0")}</b>{item}</span>
            ))}
          </section>

          <section className="library-section" id="games">
            <div className="section-heading">
              <div><p className="eyebrow">Game library</p><h2>{catalog.length} {catalog.length === 1 ? "game" : "games"}. One way to play.</h2></div>
              <p>Search by name or control, then show only the games that work with the devices you have.</p>
            </div>

            <form className="catalog-controls" role="search" onSubmit={(event) => event.preventDefault()}>
              <label className="catalog-control" htmlFor="catalog-search">
                <span>Search games</span>
                <input
                  id="catalog-search"
                  type="search"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setRequestedPageStart(null);
                  }}
                  placeholder="Name, description, or input"
                  autoComplete="off"
                  aria-controls="catalog-results"
                />
              </label>
              <label className="catalog-control" htmlFor="catalog-input-filter">
                <span>Works with</span>
                <select
                  id="catalog-input-filter"
                  value={inputFilter}
                  onChange={(event) => {
                    setInputFilter(event.currentTarget.value as CatalogInputFilter);
                    setRequestedPageStart(null);
                  }}
                  aria-controls="catalog-results"
                >
                  <option value="all">Any available input</option>
                  {CATALOG_INPUT_PROFILES.map((profile) => (
                    <option value={profile.id} key={profile.id}>{profile.label}</option>
                  ))}
                </select>
              </label>
              <button className="catalog-reset" type="button" onClick={resetCatalog} disabled={!hasCatalogSelection}>
                Reset
              </button>
            </form>

            <div className="catalog-results-heading">
              <p aria-live="polite" aria-atomic="true">{resultCountCopy}</p>
              <span aria-hidden="true">{query !== deferredQuery ? "Updating…" : ""}</span>
            </div>

            {filteredCatalog.length === 0 ? (
              <div className="catalog-empty" id="catalog-results">
                <span aria-hidden="true">0 / {catalog.length}</span>
                <h3>No games match this search and input profile.</h3>
                <p>Reset the library filters to browse every game.</p>
                <button className="outline-button" type="button" onClick={resetCatalog}>Reset search and filter</button>
              </div>
            ) : (
              <section
                className="catalog-results-region"
                id="catalog-results"
                aria-busy={query !== deferredQuery}
                aria-label="Game search results"
              >
                {catalogPager}
                <div className="game-grid catalog-grid" ref={gridRef} role="list">
                  <CatalogSpacer
                    position="top"
                    itemCount={filteredCatalog.length}
                    startIndex={renderWindow.startIndex}
                    endIndex={renderWindow.endIndex}
                  />
                  {visibleCatalog.map((game, index) => {
                  const position = renderWindow.startIndex + index + 1;
                  return (
                    <article
                      className={`game-card catalog-game-card game-${game.id}`}
                      key={game.id}
                      ref={index === 0 ? pageFocusTargetRef : undefined}
                      tabIndex={-1}
                      role="listitem"
                      aria-setsize={filteredCatalog.length}
                      aria-posinset={position}
                    >
                      <div className="card-top">
                        <span className="game-number">{String(position).padStart(2, "0")}</span>
                        {benchmarkMode
                          ? <span className="roadmap-badge">BENCHMARK</span>
                          : game.status === "playable"
                            ? null
                            : <span className="roadmap-badge">Coming soon</span>}
                      </div>
                      <GamePoster id={game.id} title={game.name} />
                      <div className="game-card-copy">
                        <h3>{game.name}</h3>
                        <p>{game.tagline}</p>
                        <div className="input-tags">
                          {game.inputs.slice(0, 3).map((input) => <span key={input}><Icon name={input} size={16} />{CATALOG_INPUT_LABELS[input] ?? input}</span>)}
                          {game.inputs.length > 3 && <span>+{game.inputs.length - 3}</span>}
                        </div>
                        {/* Was three fixed strings, including the literal "Playable" printed on every
                            card in the catalog — ROADMAP ones included, directly under a badge that
                            said otherwise. Now computed against what this browser can contribute. */}
                        {(() => {
                          const readiness = readinessOn(game, localSources);
                          return <p className={`card-readiness${readiness.ok ? "" : " needs-device"}`}>{readiness.text}</p>;
                        })()}
                      </div>
                      {benchmarkMode ? (
                        <div className="card-status"><span>LOCAL FIXTURE</span><span>{game.players.max}P</span><span>∞</span></div>
                      ) : game.status === "playable" ? (
                        <Link className="game-card-launch" href={`/games/${game.id}`}>Play <Icon name="arrow" size={16} /></Link>
                      ) : (
                        <div className="card-status"><span>Coming soon</span><span>{game.players.max === 1 ? "1 player" : `Up to ${game.players.max} players`}</span></div>
                      )}
                    </article>
                  );
                  })}
                  {catalogKeyboardPager}
                  <CatalogSpacer
                    position="bottom"
                    itemCount={filteredCatalog.length}
                    startIndex={renderWindow.startIndex}
                    endIndex={renderWindow.endIndex}
                  />
                </div>
              </section>
            )}
          </section>

      <footer className="footer">
        <div className="mark-block">101</div>
        <p>Almost anything can become a controller.</p>
        <div><Link href="/devices">Devices</Link><Link href="/studio">Developers</Link></div>
      </footer>

      {pairingOpen && <PairingPanel sessionId={sessionId} onClose={() => setPairingOpen(false)} onOpenController={() => setPairingOpen(false)} />}
    </main>
  );
}


/**
 * Whether this browser can play a game right now, and what would improve it.
 *
 * A game's declared inputs are alternatives, not requirements — Slashstorm takes a keyboard or a
 * touchscreen or a gamepad — so covering any one of them means you can start. The rest are the
 * honest answer to "what would make this better", which is a different sentence from "you cannot
 * play this". The card used to print neither: it printed the literal string "Playable" on every
 * card in the catalog, including the ones whose own badge above said ROADMAP.
 */
function readinessOn(game: LauncherCatalogEntry, local: readonly InputSource[]): { ok: boolean; text: string } {
  if (game.status !== "playable") return { ok: false, text: "Coming soon" };

  const have = game.inputs.filter((input) => local.includes(input));
  const missing = game.inputs.filter((input) => !local.includes(input));
  const name = (input: InputSource) => CATALOG_INPUT_LABELS[input] ?? input;

  if (have.length === 0) return { ok: false, text: `Needs ${missing.slice(0, 2).map(name).join(" or ")}` };
  if (missing.length === 0) return { ok: true, text: "Ready on this device" };
  return { ok: true, text: `Ready now · ${missing.slice(0, 2).map(name).join(", ")} adds more` };
}

interface CatalogViewport {
  columns: number;
  rowHeight: number;
  viewportTop: number;
  viewportHeight: number;
  ready: boolean;
}

function useCatalogWindow(itemCount: number, active: boolean) {
  const gridRef = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const [viewport, setViewport] = useState<CatalogViewport>({
    columns: INITIAL_CATALOG_COLUMNS,
    rowHeight: INITIAL_CATALOG_ROW_HEIGHT,
    viewportTop: 0,
    viewportHeight: 0,
    ready: false,
  });

  const measure = useCallback(() => {
    const grid = gridRef.current;
    if (!grid) return;

    const columnTracks = window.getComputedStyle(grid).gridTemplateColumns
      .split(/\s+/)
      .filter(Boolean);
    const columns = Math.max(1, columnTracks.length);
    const firstCard = grid.querySelector<HTMLElement>(".catalog-game-card");
    const measuredRowHeight = firstCard?.getBoundingClientRect().height;
    const viewportTop = Math.max(0, -grid.getBoundingClientRect().top);
    const viewportHeight = Math.max(0, window.innerHeight);

    setViewport((previous) => {
      const rowHeight = measuredRowHeight && measuredRowHeight > 0
        ? measuredRowHeight
        : previous.rowHeight;
      if (
        previous.ready
        && previous.columns === columns
        && Math.abs(previous.rowHeight - rowHeight) < 0.01
        && Math.abs(previous.viewportTop - viewportTop) < 1
        && previous.viewportHeight === viewportHeight
      ) return previous;
      return { columns, rowHeight, viewportTop, viewportHeight, ready: true };
    });
  }, []);

  const scheduleMeasurement = useCallback(() => {
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = window.requestAnimationFrame(() => {
      animationFrameRef.current = null;
      measure();
    });
  }, [measure]);

  useEffect(() => {
    if (!active || itemCount === 0) return;
    const grid = gridRef.current;
    if (!grid) return;

    const resizeObserver = new ResizeObserver(scheduleMeasurement);
    resizeObserver.observe(grid);
    window.addEventListener("scroll", scheduleMeasurement, { passive: true });
    window.addEventListener("resize", scheduleMeasurement);
    scheduleMeasurement();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", scheduleMeasurement);
      window.removeEventListener("resize", scheduleMeasurement);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [active, itemCount, scheduleMeasurement]);

  const windowPlan = useMemo<CatalogWindowPlan>(() => {
    if (!viewport.ready) return initialCatalogWindow(itemCount);
    return planCatalogWindow({
      itemCount,
      columns: viewport.columns,
      rowHeight: viewport.rowHeight,
      viewportTop: viewport.viewportTop,
      viewportHeight: viewport.viewportHeight,
      overscanRows: 2,
    });
  }, [itemCount, viewport]);

  const anchorIndex = useMemo(() => {
    if (!viewport.ready || itemCount === 0) return 0;
    const totalRows = Math.ceil(itemCount / viewport.columns);
    const anchorOffset = Math.min(
      totalRows * viewport.rowHeight - 1,
      Math.max(0, viewport.viewportTop + viewport.viewportHeight / 2),
    );
    const anchorRow = Math.floor(anchorOffset / viewport.rowHeight);
    return Math.min(itemCount - 1, anchorRow * viewport.columns);
  }, [itemCount, viewport]);

  return { anchorIndex, gridRef, windowPlan };
}

function initialCatalogWindow(itemCount: number): CatalogWindowPlan {
  const endIndex = Math.min(itemCount, INITIAL_CATALOG_ITEMS);
  const totalRows = Math.ceil(itemCount / INITIAL_CATALOG_COLUMNS);
  const endRow = Math.ceil(endIndex / INITIAL_CATALOG_COLUMNS);
  const totalHeight = totalRows * INITIAL_CATALOG_ROW_HEIGHT;
  return {
    startIndex: 0,
    endIndex,
    startRow: 0,
    endRow,
    totalRows,
    totalHeight,
    topSpacer: 0,
    bottomSpacer: Math.max(0, totalHeight - endRow * INITIAL_CATALOG_ROW_HEIGHT),
  };
}

interface CatalogPagePlan {
  startIndex: number;
  endIndex: number;
}

function planCatalogPage(
  itemCount: number,
  requestedIndex: number,
  pageSize = INITIAL_CATALOG_ITEMS,
): CatalogPagePlan {
  if (itemCount === 0) return { startIndex: 0, endIndex: 0 };
  const lastPageStart = Math.floor((itemCount - 1) / pageSize) * pageSize;
  const requestedPageStart = Math.floor(Math.max(0, requestedIndex) / pageSize) * pageSize;
  const startIndex = Math.min(lastPageStart, requestedPageStart);
  return { startIndex, endIndex: Math.min(itemCount, startIndex + pageSize) };
}

function CatalogSpacer({
  position,
  itemCount,
  startIndex,
  endIndex,
}: {
  position: "top" | "bottom";
  itemCount: number;
  startIndex: number;
  endIndex: number;
}) {
  const offsetItems = position === "top" ? startIndex : itemCount - endIndex;
  if (offsetItems <= 0) return null;
  const rows = (columns: number) => position === "top"
    ? Math.floor(startIndex / columns)
    : Math.ceil((itemCount - endIndex) / columns);
  const style = {
    "--catalog-spacer-height-1": `${rows(1) * 470}px`,
    "--catalog-spacer-height-2": `${rows(2) * 470}px`,
    "--catalog-spacer-height-3": `${rows(3) * 500}px`,
  } as React.CSSProperties;
  return <div className="catalog-spacer" style={style} role="presentation" aria-hidden="true" />;
}

function PairingPanel({ sessionId, onClose, onOpenController }: { sessionId: string; onClose: () => void; onOpenController: () => void }) {
  const [copied, setCopied] = useState(false);
  const [pairing, setPairing] = useState<BrowserPairingInfo>();
  const [qrCode, setQrCode] = useState("");
  const [hubError, setHubError] = useState("");
  const controllerUrl = `/controller?session=${sessionId}`;

  useEffect(() => {
    let current = true;
    getBrowserHostTransport(sessionId).preparePairing().then(async (info) => {
      const image = await QRCode.toDataURL(info.controllerUrl, { width: 280, margin: 2, errorCorrectionLevel: "M", // The QR library needs literal hex, not a CSS variable, so these mirror --ink and --paper.
        color: { dark: "#0a0a0a", light: "#f2f2f2" } });
      if (!current) return;
      setPairing(info);
      setQrCode(image);
      setHubError("");
    }).catch((error) => {
      if (current) setHubError(error instanceof Error ? error.message : "Local Hub unavailable");
    });
    return () => { current = false; };
  }, [sessionId]);

  const copy = async () => {
    await navigator.clipboard?.writeText(pairing?.controllerUrl ?? new URL(controllerUrl, window.location.origin).toString());
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="pairing-panel" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
        <button className="close-button" onClick={onClose} aria-label="Close">×</button>
        <p className="eyebrow">Add a controller</p>
        <h2 id="pairing-title">Scan once. Control every game.</h2>
        <p className="panel-intro">Scan the code with your phone. Its screen becomes a controller, and the buttons change to match whatever you are playing.</p>
        {/* A generated data URL is intentionally rendered directly; it never leaves the local browser. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qrCode ? <img className="pairing-qr" src={qrCode} alt={`QR code for local session ${sessionId}`} /> : <div className="pairing-qr pending"><span>{hubError ? "HUB OFFLINE" : "PREPARING QR"}</span></div>}
        <div className="session-code"><span>Room code</span><strong>{sessionId}</strong></div>
        <div className="pair-link"><code>{pairing?.controllerUrl ?? controllerUrl}</code><button onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
        {hubError && <p className="pairing-error">Couldn&apos;t reach the other devices on this network. Check that this device is online, then try again.</p>}
        <a className="primary-button full-button" href={pairing?.controllerUrl ?? controllerUrl} target="_blank" rel="noreferrer" onClick={onOpenController}>Open 101 Link ↗</a>
      </section>
    </div>
  );
}

