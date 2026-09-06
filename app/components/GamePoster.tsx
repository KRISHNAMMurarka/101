/**
 * Game posters.
 *
 * The card's picture used to be three empty tags — <span/> <i/> <b/> — that CSS bent into the same
 * rotated rectangle, circle and bar for all eleven games, with six per-game overrides nudging the
 * magic numbers. Eleven games, three shapes. Replacing them with input icons answered "what do I
 * need to play this?" but a row of device glyphs is still not a picture of a game.
 *
 * So each poster is drawn from what its game actually is, taken from its own tagline: Slashstorm
 * turns motion into a blade, so it is a blade arc; Echo Maze is about what the dark hides, so it is
 * a maze with one lit cone; Swarm Commander is hundreds of agents with one intent, so it is a
 * formation converging. No two share a composition, because no two games share a mechanic.
 *
 * These carry colour, and they are the only part of the interface that does. The chrome is
 * monochrome by decision — a controller and a game screen compete for the same attention, so the
 * frame around the game stays out of the way — but a poster stands for the game, not the frame.
 */

type PosterProps = { id: string; title: string };

const VIEW = "0 0 320 200";

/** Each palette belongs to one game's world, and is stated once here rather than per element. */
const POSTERS: Record<string, { ground: string; art: (id: string) => React.ReactNode }> = {
  slashstorm: {
    ground: "#1a0710",
    art: (id) => (
      <>
        <defs>
          <linearGradient id={`${id}-a`} x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#ff2d55" stopOpacity="0" />
            <stop offset="0.55" stopColor="#ff3b5c" />
            <stop offset="1" stopColor="#ffb03a" />
          </linearGradient>
        </defs>
        {/* Three trailing arcs behind one bright edge: the blade is the motion, not the object. */}
        <path d="M18 178 C110 168 214 116 300 22" stroke="#ff2d55" strokeOpacity="0.14" strokeWidth="26" fill="none" />
        <path d="M24 176 C114 162 210 110 296 26" stroke="#ff2d55" strokeOpacity="0.26" strokeWidth="14" fill="none" />
        <path d="M30 174 C118 156 206 104 292 30" stroke={`url(#${id}-a)`} strokeWidth="5" fill="none" />
        <circle cx="292" cy="30" r="7" fill="#ffd08a" />
        <circle cx="292" cy="30" r="16" fill="#ffb03a" fillOpacity="0.22" />
        {[[248, 62], [214, 90], [176, 116]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3 - i * 0.6} fill="#ffb03a" fillOpacity={0.8 - i * 0.2} />
        ))}
      </>
    ),
  },

  tiltdrift: {
    ground: "#04121f",
    art: (id) => (
      <>
        <defs>
          <linearGradient id={`${id}-r`} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#22d3ee" stopOpacity="0.9" />
            <stop offset="1" stopColor="#22d3ee" stopOpacity="0.08" />
          </linearGradient>
        </defs>
        {/* A road narrowing into a chicane: every corner is the decision. */}
        <path d="M96 200 C120 130 196 118 168 66 C152 36 176 18 208 6" stroke={`url(#${id}-r)`} strokeWidth="46" fill="none" strokeLinecap="round" />
        <path d="M96 200 C120 130 196 118 168 66 C152 36 176 18 208 6" stroke="#7dd3fc" strokeWidth="1.5" strokeDasharray="9 13" fill="none" />
        <path d="M52 96 C74 92 92 80 104 60" stroke="#0ea5e9" strokeOpacity="0.5" strokeWidth="2" fill="none" />
        <path d="M244 158 C258 128 262 100 254 74" stroke="#0ea5e9" strokeOpacity="0.35" strokeWidth="2" fill="none" />
        <circle cx="118" cy="152" r="9" fill="#f8fafc" />
        <path d="M118 152 C104 168 96 182 94 198" stroke="#f8fafc" strokeOpacity="0.4" strokeWidth="3" fill="none" />
      </>
    ),
  },

  bodydodge: {
    ground: "#07150b",
    art: (id) => (
      <>
        <defs>
          {/* The wall is drawn as one path with a body-shaped hole, evenodd, so the gap is a real
              absence rather than a patch painted back over it in the ground colour. */}
          <linearGradient id={`${id}-w`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#bef264" />
            <stop offset="1" stopColor="#4d7c0f" />
          </linearGradient>
        </defs>
        {[0, 1].map((i) => (
          <rect key={i} x={132 - i * 62} y={26 + i * 10} width="16" height={148 - i * 20} rx="2"
            fill="#a3e635" fillOpacity={0.16 - i * 0.07} />
        ))}
        <path
          fillRule="evenodd"
          fill={`url(#${id}-w)`}
          d="M196 8 H300 V192 H196 Z
             M248 40 a13 13 0 1 1 0 26 a13 13 0 1 1 0 -26 Z
             M248 68 c17 0 24 16 24 32 v20 h-9 v42 h-12 v-42 h-6 v42 h-12 v-42 h-9 v-20 c0 -16 7 -32 24 -32 Z"
        />
        <g fill="#ecfccb">
          <circle cx="86" cy="58" r="14" />
          <path d="M86 76 c18 0 26 17 26 34 v22 h-10 v46 h-13 v-46 h-6 v46 h-13 v-46 h-10 v-22 c0 -17 8 -34 26 -34 Z" />
        </g>
        <g stroke="#a3e635" strokeOpacity="0.55" strokeWidth="2" strokeLinecap="round">
          <path d="M124 84 H150" /><path d="M124 104 H162" /><path d="M124 124 H144" />
        </g>
      </>
    ),
  },

  orbitalcrew: {
    ground: "#0a0918",
    art: (id) => (
      <>
        <defs>
          <linearGradient id={`${id}-h`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fde68a" />
            <stop offset="1" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
        <ellipse cx="160" cy="100" rx="140" ry="62" stroke="#fbbf24" strokeOpacity="0.16" strokeWidth="1.5" fill="none" />
        <ellipse cx="160" cy="100" rx="104" ry="88" stroke="#fbbf24" strokeOpacity="0.1" strokeWidth="1.5" fill="none" />

        {/* One hull: body, twin nacelles, bridge. */}
        <g>
          <path d="M160 34 C176 58 182 84 182 106 L182 138 C182 152 172 162 160 162 C148 162 138 152 138 138 L138 106 C138 84 144 58 160 34 Z" fill={`url(#${id}-h)`} />
          <path d="M138 96 L112 112 L112 140 L138 130 Z" fill="#f59e0b" fillOpacity="0.85" />
          <path d="M182 96 L208 112 L208 140 L182 130 Z" fill="#f59e0b" fillOpacity="0.85" />
          <circle cx="160" cy="76" r="9" fill="#0a0918" />
          <rect x="150" y="112" width="20" height="7" rx="3.5" fill="#0a0918" fillOpacity="0.55" />
          <rect x="150" y="126" width="20" height="7" rx="3.5" fill="#0a0918" fillOpacity="0.55" />
        </g>

        {/* Four stations, each a different screen, all wired to the same hull. */}
        {[[34, 74], [34, 132], [286, 74], [286, 132]].map(([x, y], i) => (
          <g key={i}>
            <path d={`M160 100 L${x} ${y}`} stroke="#fbbf24" strokeOpacity="0.24" strokeWidth="1.5" strokeDasharray="3 6" />
            <rect x={x - 15} y={y - 11} width="30" height="22" rx="3" fill="#0a0918" stroke="#fbbf24" strokeWidth="1.5" />
            <line x1={x - 8} y1={y - 3} x2={x + 8} y2={y - 3} stroke="#fde68a" strokeOpacity="0.8" strokeWidth="1.5" />
            <line x1={x - 8} y1={y + 3} x2={x + 2} y2={y + 3} stroke="#fde68a" strokeOpacity="0.45" strokeWidth="1.5" />
          </g>
        ))}

        {/* The shared fate. */}
        <g transform="translate(258 30)">
          <path d="M0 -11 L10 7 L-10 7 Z" fill="#f87171" />
          <path d="M0 -4 V2" stroke="#0a0918" strokeWidth="2" />
        </g>
      </>
    ),
  },

  beatforge: {
    ground: "#1b0726",
    art: (id) => (
      <>
        <defs>
          <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#f472b6" />
            <stop offset="1" stopColor="#fb923c" />
          </linearGradient>
        </defs>
        {/* Notes falling to a judgment line, over the pulse that sets it. */}
        {[0, 1, 2].map((i) => (
          <circle key={i} cx="160" cy="100" r={44 + i * 30} stroke="#f472b6" strokeOpacity={0.3 - i * 0.09} strokeWidth="2" fill="none" />
        ))}
        <line x1="30" y1="150" x2="290" y2="150" stroke={`url(#${id}-b)`} strokeWidth="3" />
        {[[70, 118], [116, 78], [160, 40], [204, 78], [250, 118]].map(([x, y], i) => (
          <rect key={i} x={x - 13} y={y} width="26" height="9" rx="4.5" fill="#fb923c" fillOpacity={0.45 + i * 0.05} />
        ))}
        <path d="M30 176 L58 176 L70 160 L84 190 L98 168 L112 176 L290 176" stroke="#f472b6" strokeOpacity="0.65" strokeWidth="2" fill="none" />
      </>
    ),
  },

  gravitystack: {
    ground: "#1c1206",
    art: () => (
      <>
        {/* A leaning stack, and the arrow that keeps changing which way down is. */}
        <path d="M262 46 A78 78 0 0 1 262 154" stroke="#fb923c" strokeOpacity="0.45" strokeWidth="2" fill="none" strokeDasharray="6 8" />
        <path d="M262 154 l-9 -13 l16 -3 Z" fill="#fb923c" />
        {[[92, 156, 76, 26, -2], [98, 128, 66, 26, 5], [88, 100, 72, 26, -6], [102, 72, 54, 26, 9], [96, 46, 44, 24, -4]].map(([x, y, w, h, r], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} rx="3"
            fill="#fdba74" fillOpacity={0.32 + i * 0.13} transform={`rotate(${r} ${Number(x) + Number(w) / 2} ${Number(y) + Number(h) / 2})`} />
        ))}
        <line x1="52" y1="184" x2="238" y2="184" stroke="#fb923c" strokeOpacity="0.55" strokeWidth="2" />
      </>
    ),
  },

  spellcaster: {
    ground: "#150a2b",
    art: (id) => (
      <>
        <defs>
          <linearGradient id={`${id}-s`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#a78bfa" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>
        {/* One unbroken stroke with its turning points marked: the gesture is the spell. */}
        <circle cx="160" cy="100" r="74" stroke="#a78bfa" strokeOpacity="0.2" strokeWidth="1.5" fill="none" />
        <path d="M96 138 L160 34 L224 138 L84 74 L236 74 Z" stroke={`url(#${id}-s)`} strokeWidth="3" fill="none" strokeLinejoin="round" />
        {[[96, 138], [160, 34], [224, 138], [84, 74], [236, 74]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="5" fill="#e9d5ff" />
        ))}
        <circle cx="160" cy="100" r="12" fill="#22d3ee" fillOpacity="0.35" />
      </>
    ),
  },

  echomaze: {
    ground: "#080809",
    art: (id) => (
      <>
        <defs>
          <radialGradient id={`${id}-t`} cx="0.28" cy="0.55" r="0.55">
            <stop offset="0" stopColor="#fcd34d" stopOpacity="0.5" />
            <stop offset="1" stopColor="#fcd34d" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Corridors the torch does not reach stay unreadable. That is the game. */}
        <g stroke="#fcd34d" strokeOpacity="0.1" strokeWidth="2" fill="none">
          <path d="M40 40 H150 V90 H100 V160" /><path d="M200 30 V96 H270 V170" />
          <path d="M60 110 H120 V180" /><path d="M170 130 H236" />
        </g>
        <path d="M90 110 L214 34 L214 176 Z" fill={`url(#${id}-t)`} />
        <g stroke="#fde68a" strokeWidth="2.5" fill="none">
          <path d="M120 66 H162 V110" /><path d="M120 148 H166" />
        </g>
        <circle cx="90" cy="110" r="6" fill="#fde68a" />
      </>
    ),
  },

  shadowarena: {
    ground: "#0c0507",
    art: (id) => (
      <>
        <defs>
          <radialGradient id={`${id}-l`} cx="0.5" cy="0.28" r="0.72">
            <stop offset="0" stopColor="#ef4444" stopOpacity="0.5" />
            <stop offset="1" stopColor="#ef4444" stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* Backlit, so the player is the negative space. */}
        <ellipse cx="160" cy="72" rx="130" ry="88" fill={`url(#${id}-l)`} />
        <ellipse cx="160" cy="184" rx="104" ry="16" fill="#ef4444" fillOpacity="0.16" />
        <g fill="#08040a">
          <circle cx="160" cy="52" r="19" />
          <path d="M160 72 C186 72 196 96 196 122 L196 178 H124 V122 C124 96 134 72 160 72 Z" />
          <path d="M126 92 L86 128 L96 140 L134 110 Z" />
          <path d="M194 92 L236 126 L226 140 L186 110 Z" />
        </g>
        <path d="M236 126 L272 96" stroke="#f87171" strokeWidth="4" strokeLinecap="round" />
      </>
    ),
  },

  swarmcommander: {
    ground: "#050f22",
    art: () => {
      // A deterministic formation: a curved flow that tightens toward one point.
      const agents = Array.from({ length: 52 }, (_, i) => {
        const t = i / 51;
        const spread = 46 * (1 - t) + 3;
        const wobble = Math.sin(i * 2.399) * spread;
        return { x: 24 + t * 244, y: 150 - t * 78 + wobble, o: 0.3 + t * 0.6, r: 2 + t * 1.6 };
      });
      return (
        <>
          <path d="M24 150 C110 150 208 108 268 72" stroke="#38bdf8" strokeOpacity="0.16" strokeWidth="42" fill="none" strokeLinecap="round" />
          {agents.map((a, i) => (
            <circle key={i} cx={a.x} cy={a.y} r={a.r} fill="#7dd3fc" fillOpacity={a.o} />
          ))}
          <circle cx="278" cy="66" r="13" stroke="#f0f9ff" strokeWidth="2" fill="none" />
          <circle cx="278" cy="66" r="4" fill="#f0f9ff" />
        </>
      );
    },
  },

  "input-lab": {
    ground: "#0c0c0d",
    art: () => (
      <>
        {/* The one poster that stays monochrome: it is a diagnostic, not a game. */}
        {[[16, 30], [16, 170], [304, 30], [304, 170], [160, 8], [160, 192]].map(([x, y], i) => (
          <g key={i}>
            <line x1={x} y1={y} x2="160" y2="100" stroke="#f2f2f2" strokeOpacity="0.22" strokeWidth="1.5" />
            <circle cx={x} cy={y} r="5" stroke="#f2f2f2" strokeOpacity="0.55" strokeWidth="1.5" fill="none" />
          </g>
        ))}
        <circle cx="160" cy="100" r="26" stroke="#f2f2f2" strokeOpacity="0.3" strokeWidth="1.5" fill="none" />
        <circle cx="160" cy="100" r="11" fill="#f2f2f2" />
      </>
    ),
  },
};

/**
 * A catalog of a thousand entries cannot have a thousand hand-drawn posters, and the benchmark route
 * renders exactly that. Synthetic entries get a composition derived from their id, so they read as
 * deliberate rather than as a missing image — while never being mistaken for one of the eleven.
 */
function generatedPoster(id: string) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const bars = Array.from({ length: 7 }, (_, i) => {
    const seed = (hash >> (i * 3)) & 0x3f;
    return { x: 26 + i * 40, h: 26 + (seed % 5) * 26, o: 0.28 + (seed % 4) * 0.16 };
  });
  return (
    <>
      {bars.map((bar, i) => (
        <rect key={i} x={bar.x} y={168 - bar.h} width="26" height={bar.h} rx="3"
          fill={`hsl(${(hue + i * 12) % 360} 72% 62%)`} fillOpacity={bar.o} />
      ))}
      <line x1="18" y1="170" x2="302" y2="170" stroke={`hsl(${hue} 72% 62%)`} strokeOpacity="0.5" strokeWidth="2" />
    </>
  );
}

export function GamePoster({ id, title }: PosterProps) {
  const poster = POSTERS[id];
  const uid = `p-${id.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg className="game-poster" viewBox={VIEW} role="img" aria-label={`${title} cover`} preserveAspectRatio="xMidYMid slice">
      <rect width="320" height="200" fill={poster?.ground ?? "#101014"} />
      {poster ? poster.art(uid) : generatedPoster(id)}
    </svg>
  );
}
