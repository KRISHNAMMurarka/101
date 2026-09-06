/**
 * Game posters.
 *
 * Each poster is a scene built in four layers — ground, depth, subject, atmosphere — rather than
 * line art on a flat fill. The layers are what make a 320×200 card read as a place instead of a
 * diagram, and the recipe is shared so eleven different subjects still look like one set.
 *
 * Every value is deterministic. These render on the server and again on the client, so a
 * Math.random() star field would produce two different skies and a hydration mismatch; the
 * scatter below is derived from the index instead.
 *
 * Colour lives here and almost nowhere else in the product. The interface around a game is
 * monochrome so it does not compete with the game for attention — but a poster stands for the game,
 * not the frame, so it is allowed its own world.
 */

type Layer = React.ReactNode;

/* ---- the shared recipe ---------------------------------------------------------------------- */

/** Sky: the base gradient every poster sits on. */
function ground(id: string, from: string, to: string, vertical = true) {
  return (
    <linearGradient id={`${id}-g`} x1="0" y1={vertical ? "0" : "0"} x2={vertical ? "0" : "1"} y2={vertical ? "1" : "0"}>
      <stop offset="0" stopColor={from} />
      <stop offset="1" stopColor={to} />
    </linearGradient>
  );
}

/** A soft light source. Cheap depth: one radial does more than a dozen strokes. */
function glow(id: string, colour: string, opacity = 0.5) {
  return (
    <radialGradient id={`${id}-glow`}>
      <stop offset="0" stopColor={colour} stopOpacity={opacity} />
      <stop offset="1" stopColor={colour} stopOpacity="0" />
    </radialGradient>
  );
}

/**
 * Edge darkening, drawn last. A vignette is what stops a flat SVG reading as clip-art: it implies a
 * lens, and therefore a camera, and therefore a place.
 */
function Vignette({ id, strength = 0.55 }: { id: string; strength?: number }) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-vig`} cx="0.5" cy="0.5" r="0.75">
          <stop offset="0.45" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity={strength} />
        </radialGradient>
      </defs>
      <rect width="320" height="200" fill={`url(#${id}-vig)`} />
    </>
  );
}

/**
 * A deterministic star field. Indices through an irrational multiplier scatter without clustering,
 * and give the same sky on the server and in the browser.
 */
function stars(count: number, colour = "#ffffff", seed = 1) {
  return Array.from({ length: count }, (_, i) => {
    const n = (i + seed) * 2.399963;
    const x = ((Math.sin(n) * 43758.5) % 1 + 1) % 1 * 320;
    const y = ((Math.cos(n * 1.7) * 21393.1) % 1 + 1) % 1 * 200;
    const r = 0.5 + (((i * 7) % 5) / 5) * 1.1;
    return <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r={r.toFixed(2)} fill={colour} fillOpacity={0.2 + ((i * 13) % 7) / 12} />;
  });
}

/* ---- the eleven scenes ---------------------------------------------------------------------- */

const SCENES: Record<string, { defs: (id: string) => Layer; scene: (id: string) => Layer; vignette?: number }> = {
  slashstorm: {
    defs: (id) => (
      <>
        {ground(id, "#2b0a18", "#0a0206")}
        {glow(id, "#ff3b5c", 0.42)}
        <linearGradient id={`${id}-edge`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#ff2d55" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ff5470" />
          <stop offset="1" stopColor="#ffd08a" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        <ellipse cx="250" cy="52" rx="150" ry="120" fill={`url(#${id}-glow)`} />
        {/* Debris caught in the swing, back to front. */}
        {[[54, 150, 20, 8], [96, 128, 15, 6], [212, 152, 24, 9], [268, 122, 13, 5]].map(([x, y, w, h], i) => (
          <rect key={i} x={x} y={y} width={w} height={h} rx="1.5" fill="#ff8fa3" fillOpacity={0.1 + i * 0.03}
            transform={`rotate(${-28 + i * 19} ${Number(x) + Number(w) / 2} ${Number(y) + Number(h) / 2})`} />
        ))}
        <path d="M14 182 C108 172 216 118 306 18" stroke="#ff2d55" strokeOpacity="0.13" strokeWidth="30" fill="none" />
        <path d="M22 178 C114 164 212 112 300 22" stroke="#ff3b5c" strokeOpacity="0.28" strokeWidth="15" fill="none" />
        <path d="M30 174 C120 156 208 104 294 28" stroke={`url(#${id}-edge)`} strokeWidth="4.5" fill="none" />
        <circle cx="294" cy="28" r="20" fill="#ffb03a" fillOpacity="0.24" />
        <circle cx="294" cy="28" r="7" fill="#fff3d6" />
        {[[250, 60], [216, 88], [178, 114], [142, 138]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={3.2 - i * 0.6} fill="#ffd08a" fillOpacity={0.85 - i * 0.17} />
        ))}
      </>
    ),
  },

  tiltdrift: {
    defs: (id) => (
      <>
        {ground(id, "#0b2740", "#03101c")}
        {glow(id, "#22d3ee", 0.3)}
        <linearGradient id={`${id}-road`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" stopColor="#38bdf8" stopOpacity="0.85" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.06" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        {stars(26, "#bae6fd", 3)}
        <ellipse cx="196" cy="46" rx="130" ry="70" fill={`url(#${id}-glow)`} />
        {/* Ridge line, then the road that cuts through it. */}
        <path d="M0 96 L44 78 L82 92 L124 66 L166 86 L214 62 L262 84 L320 68 V200 H0 Z" fill="#071a2b" />
        <path d="M0 96 L44 78 L82 92 L124 66 L166 86 L214 62 L262 84 L320 68" stroke="#0ea5e9" strokeOpacity="0.35" strokeWidth="1.5" fill="none" />
        <path d="M96 200 C120 132 196 118 168 68 C152 38 176 20 208 8" stroke={`url(#${id}-road)`} strokeWidth="48" fill="none" strokeLinecap="round" />
        <path d="M96 200 C120 132 196 118 168 68 C152 38 176 20 208 8" stroke="#e0f2fe" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="8 14" fill="none" />
        <path d="M118 152 C102 170 94 184 92 200" stroke="#f8fafc" strokeOpacity="0.35" strokeWidth="5" fill="none" strokeLinecap="round" />
        <circle cx="118" cy="152" r="11" fill="#f8fafc" fillOpacity="0.25" />
        <circle cx="118" cy="152" r="5.5" fill="#ffffff" />
      </>
    ),
  },

  bodydodge: {
    defs: (id) => (
      <>
        {ground(id, "#12300f", "#040c05")}
        {glow(id, "#a3e635", 0.34)}
        <linearGradient id={`${id}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#84cc16" />
          <stop offset="0.55" stopColor="#4d7c0f" />
          <stop offset="1" stopColor="#1a2e05" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        <ellipse cx="248" cy="100" rx="120" ry="120" fill={`url(#${id}-glow)`} />
        {/* A receding floor, so the wall reads as approaching rather than pasted on. */}
        <g stroke="#a3e635" strokeOpacity="0.16" strokeWidth="1">
          {[0, 1, 2, 3, 4].map((i) => <line key={i} x1={-40 + i * 100} y1="200" x2={100 + i * 34} y2="150" />)}
          {[0, 1, 2].map((i) => <line key={i} x1="0" y1={200 - i * 26} x2="320" y2={200 - i * 26} />)}
        </g>
        {[0, 1].map((i) => (
          <rect key={i} x={130 - i * 66} y={30 + i * 12} width="14" height={140 - i * 24} rx="2"
            fill="#a3e635" fillOpacity={0.14 - i * 0.06} />
        ))}
        <path
          fillRule="evenodd"
          fill={`url(#${id}-wall)`}
          d="M196 6 H302 V194 H196 Z
             M249 38 a13 13 0 1 1 0 26 a13 13 0 1 1 0 -26 Z
             M249 66 c17 0 24 16 24 32 v20 h-9 v42 h-12 v-42 h-6 v42 h-12 v-42 h-9 v-20 c0 -16 7 -32 24 -32 Z"
        />
        <g fill="#ecfccb" fillOpacity="0.92">
          <circle cx="84" cy="56" r="14" />
          <path d="M84 74 c18 0 26 17 26 34 v22 h-10 v46 h-13 v-46 h-6 v46 h-13 v-46 h-10 v-22 c0 -17 8 -34 26 -34 Z" />
        </g>
        <g stroke="#bef264" strokeOpacity="0.5" strokeWidth="2" strokeLinecap="round">
          <path d="M124 82 H152" /><path d="M124 102 H164" /><path d="M124 122 H146" />
        </g>
      </>
    ),
  },

  orbitalcrew: {
    defs: (id) => (
      <>
        {ground(id, "#141034", "#05040f")}
        {glow(id, "#fbbf24", 0.3)}
        <linearGradient id={`${id}-hull`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fef3c7" />
          <stop offset="1" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id={`${id}-limb`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4c1d95" stopOpacity="0.9" />
          <stop offset="1" stopColor="#4c1d95" stopOpacity="0" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        {stars(34, "#e9d5ff", 7)}
        {/* A planet limb across the bottom gives the scene a floor and a scale. */}
        <ellipse cx="160" cy="290" rx="250" ry="130" fill={`url(#${id}-limb)`} />
        <ellipse cx="160" cy="290" rx="250" ry="130" stroke="#c4b5fd" strokeOpacity="0.3" strokeWidth="1.5" fill="none" />
        <ellipse cx="160" cy="98" rx="122" ry="86" fill={`url(#${id}-glow)`} />
        <ellipse cx="160" cy="98" rx="138" ry="58" stroke="#fbbf24" strokeOpacity="0.14" strokeWidth="1.5" fill="none" />
        <g>
          <path d="M160 32 C176 56 182 82 182 104 L182 136 C182 150 172 160 160 160 C148 160 138 150 138 136 L138 104 C138 82 144 56 160 32 Z" fill={`url(#${id}-hull)`} />
          <path d="M138 94 L112 110 L112 138 L138 128 Z" fill="#b45309" />
          <path d="M182 94 L208 110 L208 138 L182 128 Z" fill="#b45309" />
          <circle cx="160" cy="74" r="9" fill="#1e1b4b" />
          <rect x="150" y="110" width="20" height="6" rx="3" fill="#1e1b4b" fillOpacity="0.6" />
          <rect x="150" y="124" width="20" height="6" rx="3" fill="#1e1b4b" fillOpacity="0.6" />
          <path d="M152 160 L160 186 L168 160 Z" fill="#fbbf24" fillOpacity="0.45" />
        </g>
        {[[32, 66], [32, 132], [288, 66], [288, 132]].map(([x, y], i) => (
          <g key={i}>
            <path d={`M160 98 L${x} ${y}`} stroke="#fbbf24" strokeOpacity="0.2" strokeWidth="1.5" strokeDasharray="3 6" />
            <rect x={x - 15} y={y - 11} width="30" height="22" rx="3" fill="#0d0a24" stroke="#fbbf24" strokeWidth="1.5" />
            <line x1={x - 8} y1={y - 3} x2={x + 8} y2={y - 3} stroke="#fde68a" strokeOpacity="0.85" strokeWidth="1.5" />
            <line x1={x - 8} y1={y + 3} x2={x + 2} y2={y + 3} stroke="#fde68a" strokeOpacity="0.4" strokeWidth="1.5" />
          </g>
        ))}
        <g transform="translate(252 28)">
          <circle r="14" fill="#f87171" fillOpacity="0.16" />
          <path d="M0 -10 L9 6 L-9 6 Z" fill="#f87171" />
        </g>
      </>
    ),
  },

  beatforge: {
    defs: (id) => (
      <>
        {ground(id, "#2e0a3d", "#0d0313")}
        {glow(id, "#f472b6", 0.46)}
        <linearGradient id={`${id}-line`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f472b6" />
          <stop offset="1" stopColor="#fb923c" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        <ellipse cx="160" cy="96" rx="150" ry="110" fill={`url(#${id}-glow)`} />
        {/* Spectrum floor: the room the beat happens in. */}
        <g>
          {Array.from({ length: 26 }, (_, i) => {
            const h = 10 + Math.abs(Math.sin(i * 0.9)) * 40;
            return <rect key={i} x={6 + i * 12} y={200 - h} width="7" height={h} rx="1.5" fill="#f472b6" fillOpacity={0.1 + (i % 4) * 0.045} />;
          })}
        </g>
        {[0, 1, 2].map((i) => (
          <circle key={i} cx="160" cy="94" r={40 + i * 32} stroke="#f9a8d4" strokeOpacity={0.34 - i * 0.1} strokeWidth="2" fill="none" />
        ))}
        <line x1="26" y1="146" x2="294" y2="146" stroke={`url(#${id}-line)`} strokeWidth="3" />
        <rect x="26" y="143" width="268" height="6" fill="#fb923c" fillOpacity="0.14" />
        {[[68, 112], [114, 72], [160, 34], [206, 72], [252, 112]].map(([x, y], i) => (
          <g key={i}>
            <rect x={x - 14} y={y} width="28" height="10" rx="5" fill="#fdba74" fillOpacity={0.5 + i * 0.08} />
            <rect x={x - 14} y={y} width="28" height="10" rx="5" fill="none" stroke="#fff7ed" strokeOpacity="0.35" strokeWidth="1" />
          </g>
        ))}
      </>
    ),
  },

  gravitystack: {
    defs: (id) => (
      <>
        {ground(id, "#3a2409", "#100a03")}
        {glow(id, "#fb923c", 0.34)}
        <linearGradient id={`${id}-block`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fed7aa" />
          <stop offset="1" stopColor="#c2410c" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        <ellipse cx="130" cy="150" rx="150" ry="110" fill={`url(#${id}-glow)`} />
        <rect x="0" y="176" width="320" height="24" fill="#0d0703" />
        <ellipse cx="130" cy="178" rx="76" ry="9" fill="#000" fillOpacity="0.45" />
        <path d="M258 42 A80 80 0 0 1 258 158" stroke="#fdba74" strokeOpacity="0.4" strokeWidth="2" fill="none" strokeDasharray="6 8" />
        <path d="M258 158 l-9 -13 l16 -3 Z" fill="#fdba74" />
        {[[92, 150, 78, 26, -2], [98, 122, 68, 26, 5], [86, 94, 74, 26, -6], [102, 66, 56, 26, 9], [96, 40, 46, 24, -4]].map(([x, y, w, h, r], i) => (
          <g key={i} transform={`rotate(${r} ${Number(x) + Number(w) / 2} ${Number(y) + Number(h) / 2})`}>
            <rect x={x} y={y} width={w} height={h} rx="3" fill={`url(#${id}-block)`} fillOpacity={0.45 + i * 0.13} />
            <rect x={x} y={y} width={w} height="3" rx="1.5" fill="#fff7ed" fillOpacity={0.25 + i * 0.08} />
          </g>
        ))}
        <line x1="44" y1="176" x2="240" y2="176" stroke="#fb923c" strokeOpacity="0.6" strokeWidth="2" />
      </>
    ),
  },

  spellcaster: {
    defs: (id) => (
      <>
        {ground(id, "#2a1152", "#0a041a")}
        {glow(id, "#a78bfa", 0.5)}
        <linearGradient id={`${id}-rune`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="0.5" stopColor="#818cf8" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </>
    ),
    scene: (id) => (
      <>
        {stars(18, "#ddd6fe", 11)}
        <ellipse cx="160" cy="98" rx="130" ry="110" fill={`url(#${id}-glow)`} />
        {[86, 66, 46].map((r, i) => (
          <circle key={i} cx="160" cy="98" r={r} stroke="#a78bfa" strokeOpacity={0.14 + i * 0.05} strokeWidth="1"
            fill="none" strokeDasharray={i === 1 ? "3 9" : undefined} />
        ))}
        <path d="M96 136 L160 32 L224 136 L84 72 L236 72 Z" stroke={`url(#${id}-rune)`} strokeWidth="7" strokeOpacity="0.2" fill="none" strokeLinejoin="round" />
        <path d="M96 136 L160 32 L224 136 L84 72 L236 72 Z" stroke={`url(#${id}-rune)`} strokeWidth="2.5" fill="none" strokeLinejoin="round" />
        {[[96, 136], [160, 32], [224, 136], [84, 72], [236, 72]].map(([x, y], i) => (
          <g key={i}>
            <circle cx={x} cy={y} r="9" fill="#c4b5fd" fillOpacity="0.2" />
            <circle cx={x} cy={y} r="4" fill="#f5f3ff" />
          </g>
        ))}
        <circle cx="160" cy="98" r="16" fill="#22d3ee" fillOpacity="0.3" />
        <circle cx="160" cy="98" r="6" fill="#ecfeff" />
      </>
    ),
  },

  echomaze: {
    defs: (id) => (
      <>
        {ground(id, "#0a1018", "#030407")}
        <radialGradient id={`${id}-torch`} cx="0.28" cy="0.55" r="0.6">
          <stop offset="0" stopColor="#fcd34d" stopOpacity="0.55" />
          <stop offset="0.55" stopColor="#f59e0b" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </>
    ),
    scene: (id) => (
      <>
        {/* Unlit corridors stay barely legible. That withholding is the game. */}
        <g stroke="#93c5fd" strokeOpacity="0.07" strokeWidth="3" fill="none" strokeLinecap="square">
          <path d="M34 34 H148 V88 H98 V166" /><path d="M198 24 V94 H272 V176" />
          <path d="M56 108 H118 V186" /><path d="M168 128 H240" /><path d="M240 40 V96" />
        </g>
        <path d="M88 108 L226 26 L226 182 Z" fill={`url(#${id}-torch)`} />
        <g stroke="#fde68a" strokeOpacity="0.9" strokeWidth="3" fill="none" strokeLinecap="square">
          <path d="M118 62 H162 V108" /><path d="M118 150 H168" />
        </g>
        <g stroke="#fcd34d" strokeOpacity="0.28" strokeWidth="3" fill="none">
          <path d="M162 108 V140" /><path d="M196 62 V94" />
        </g>
        <circle cx="88" cy="108" r="14" fill="#fcd34d" fillOpacity="0.2" />
        <circle cx="88" cy="108" r="5" fill="#fffbeb" />
      </>
    ),
  },

  shadowarena: {
    defs: (id) => (
      <>
        {ground(id, "#2a0810", "#080205")}
        <radialGradient id={`${id}-spot`} cx="0.5" cy="0.2" r="0.8">
          <stop offset="0" stopColor="#fca5a5" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#ef4444" stopOpacity="0.28" />
          <stop offset="1" stopColor="#ef4444" stopOpacity="0" />
        </radialGradient>
      </>
    ),
    scene: (id) => (
      <>
        <ellipse cx="160" cy="60" rx="150" ry="130" fill={`url(#${id}-spot)`} />
        {/* A crowd line reads as an arena without drawing one. */}
        <g fill="#150407">
          {Array.from({ length: 22 }, (_, i) => (
            <circle key={i} cx={4 + i * 15} cy={128 + Math.sin(i * 1.3) * 4} r={7 + (i % 3)} />
          ))}
          <rect x="0" y="132" width="320" height="20" />
        </g>
        <ellipse cx="160" cy="182" rx="112" ry="18" fill="#ef4444" fillOpacity="0.14" />
        <ellipse cx="160" cy="182" rx="66" ry="10" fill="#000" fillOpacity="0.5" />
        <g fill="#0a0205">
          <circle cx="160" cy="50" r="19" />
          <path d="M160 70 C186 70 196 94 196 120 L196 178 H124 V120 C124 94 134 70 160 70 Z" />
          <path d="M126 90 L84 126 L94 140 L134 108 Z" />
          <path d="M194 90 L238 124 L228 140 L186 108 Z" />
        </g>
        <path d="M238 124 L278 90" stroke="#fecaca" strokeWidth="5" strokeLinecap="round" />
        <path d="M238 124 L278 90" stroke="#ef4444" strokeOpacity="0.5" strokeWidth="11" strokeLinecap="round" />
      </>
    ),
  },

  swarmcommander: {
    defs: (id) => (
      <>
        {ground(id, "#07203c", "#020a16")}
        {glow(id, "#38bdf8", 0.34)}
      </>
    ),
    scene: (id) => {
      const agents = Array.from({ length: 64 }, (_, i) => {
        const t = i / 63;
        const spread = 44 * (1 - t) + 3;
        return {
          x: 20 + t * 250,
          y: 152 - t * 84 + Math.sin(i * 2.399) * spread,
          o: 0.28 + t * 0.62,
          r: 1.8 + t * 1.8,
        };
      });
      return (
        <>
          <ellipse cx="250" cy="66" rx="130" ry="100" fill={`url(#${id}-glow)`} />
          <g stroke="#38bdf8" strokeOpacity="0.08" strokeWidth="1">
            {[0, 1, 2, 3].map((i) => <line key={i} x1="0" y1={40 + i * 42} x2="320" y2={40 + i * 42} />)}
          </g>
          <path d="M20 152 C108 152 208 108 270 68" stroke="#38bdf8" strokeOpacity="0.14" strokeWidth="46" fill="none" strokeLinecap="round" />
          {agents.map((a, i) => (
            <circle key={i} cx={a.x.toFixed(1)} cy={a.y.toFixed(1)} r={a.r.toFixed(2)} fill="#bae6fd" fillOpacity={a.o.toFixed(2)} />
          ))}
          <circle cx="280" cy="62" r="20" fill="#e0f2fe" fillOpacity="0.1" />
          <circle cx="280" cy="62" r="13" stroke="#f0f9ff" strokeWidth="2" fill="none" />
          <circle cx="280" cy="62" r="4" fill="#ffffff" />
          <g stroke="#f0f9ff" strokeOpacity="0.7" strokeWidth="1.5">
            <path d="M280 42 V34" /><path d="M280 82 V90" /><path d="M260 62 H252" /><path d="M300 62 H308" />
          </g>
        </>
      );
    },
  },
};

/**
 * A poster for a game this build has no artwork for — a third-party title, or one added after this
 * file was written.
 *
 * This is the poster the catalog will mostly be made of once it grows, so it cannot be one
 * composition recoloured: a thousand games all showing the same ridge under a different hue reads
 * as a placeholder no matter how well drawn it is. The id selects a composition family as well as a
 * palette, so neighbouring cards differ in shape and not only in colour, and it is derived rather
 * than random so a game keeps its poster across reloads and between server and browser.
 */
function generated(id: string) {
  let raw = 0;
  for (const character of id) raw = (raw * 31 + character.charCodeAt(0)) >>> 0;

  /* A plain string hash leaves its low bits highly correlated, so `hash % 4` put four of six sample
     ids in the same composition family. One avalanche round decorrelates them, which matters here
     precisely because this is the poster most of a grown catalog will use. */
  let hash = raw;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x45d9f3b) >>> 0;
  hash ^= hash >>> 16;

  const hue = hash % 360;
  const accent = (hue + 26 + ((hash >>> 9) % 40)) % 360;
  const key = `gen-${hash.toString(36)}`;
  const family = (hash >>> 5) % 4;
  const bit = (n: number, mod: number) => ((hash >>> (n * 3 + 11)) ^ raw) % mod;

  const light = `hsl(${accent} 84% 68%)`;
  const solid = `hsl(${hue} 46% 11%)`;

  const composition = [
    // Ridge: a landform under a low sun.
    () => {
      const ridge = Array.from({ length: 9 }, (_, i) => `${i * 40} ${100 + bit(i, 7) * 9}`).join(" L ");
      return (
        <>
          <path d={`M0 200 L0 ${104 + (hash % 26)} L ${ridge} L 320 200 Z`} fill={solid} />
          <path d={`M0 ${104 + (hash % 26)} L ${ridge}`} stroke={light} strokeOpacity="0.5" strokeWidth="1.5" fill="none" />
          <circle cx={228 - (hash % 80)} cy={58 + (hash % 22)} r="8" fill={light} />
        </>
      );
    },
    // Orbit: concentric rings with bodies on them.
    () => (
      <>
        {[0, 1, 2].map((i) => (
          <ellipse key={i} cx="160" cy="100" rx={44 + i * 46} ry={30 + i * 32} stroke={light}
            strokeOpacity={0.3 - i * 0.08} strokeWidth="1.5" fill="none" />
        ))}
        {[0, 1, 2].map((i) => {
          const angle = (bit(i + 2, 12) / 12) * Math.PI * 2;
          return <circle key={i} cx={160 + Math.cos(angle) * (44 + i * 46)} cy={100 + Math.sin(angle) * (30 + i * 32)}
            r={4 + i} fill={light} fillOpacity={0.9 - i * 0.2} />;
        })}
        <circle cx="160" cy="100" r={12 + (hash % 8)} fill={light} />
      </>
    ),
    // Horizon: a receding plane, the oldest way to say "a place".
    () => (
      <>
        <rect x="0" y="128" width="320" height="72" fill={solid} />
        <g stroke={light} strokeOpacity="0.18" strokeWidth="1">
          {Array.from({ length: 7 }, (_, i) => <line key={i} x1={-120 + i * 100} y1="200" x2={110 + i * 20} y2="128" />)}
          {[0, 1, 2, 3].map((i) => <line key={i} x1="0" y1={200 - i * i * 6 - 8} x2="320" y2={200 - i * i * 6 - 8} />)}
        </g>
        <line x1="0" y1="128" x2="320" y2="128" stroke={light} strokeOpacity="0.7" strokeWidth="1.5" />
        <rect x={70 + bit(3, 6) * 26} y={92 - bit(4, 5) * 8} width="10" height={36 + bit(5, 5) * 8} fill={light} fillOpacity="0.8" />
      </>
    ),
    // Arc: a trajectory across the frame.
    () => {
      const y = 60 + bit(2, 6) * 12;
      return (
        <>
          <path d={`M-10 176 Q ${120 + bit(1, 8) * 12} ${y} 330 ${40 + bit(6, 5) * 14}`}
            stroke={light} strokeOpacity="0.16" strokeWidth="26" fill="none" />
          <path d={`M-10 176 Q ${120 + bit(1, 8) * 12} ${y} 330 ${40 + bit(6, 5) * 14}`}
            stroke={light} strokeWidth="2.5" fill="none" />
          {[0, 1, 2, 3, 4].map((i) => (
            <circle key={i} cx={24 + i * 62} cy={168 - i * (16 + bit(i, 4))} r={2.5 + (i % 3)} fill={light} fillOpacity={0.4 + i * 0.12} />
          ))}
        </>
      );
    },
  ][family];

  return (
    <>
      <defs>
        <linearGradient id={`${key}-g`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`hsl(${hue} 56% 24%)`} />
          <stop offset="1" stopColor={`hsl(${hue} 62% 6%)`} />
        </linearGradient>
        <radialGradient id={`${key}-glow`}>
          <stop offset="0" stopColor={light} stopOpacity="0.38" />
          <stop offset="1" stopColor={light} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="320" height="200" fill={`url(#${key}-g)`} />
      <ellipse cx={70 + (hash % 180)} cy={50 + (hash % 60)} rx="140" ry="104" fill={`url(#${key}-glow)`} />
      {composition()}
    </>
  );
}

export function GamePoster({ id, title }: { id: string; title: string }) {
  const scene = SCENES[id];
  const uid = `p-${id.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg className="game-poster" viewBox="0 0 320 200" role="img" aria-label={title} preserveAspectRatio="xMidYMid slice">
      {scene ? (
        <>
          <defs>{scene.defs(uid)}</defs>
          <rect width="320" height="200" fill={`url(#${uid}-g)`} />
          {scene.scene(uid)}
        </>
      ) : (
        generated(id)
      )}
      <Vignette id={uid} strength={scene?.vignette ?? 0.5} />
    </svg>
  );
}
