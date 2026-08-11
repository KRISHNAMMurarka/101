import type { SessionRole } from "@101/session";

export const SPELLCASTER_ROLES: readonly SessionRole[] = [
  {
    id: "sorcerer",
    label: "Arcane Caster",
    playerId: "role-sorcerer",
    requiredCapabilities: ["touch"],
    preferredCapabilities: ["gyroscope", "haptics"],
    layout: {
      title: "Arcane Focus",
      accent: "#7dfbd7",
      motion: {
        action: "spell.aim",
        mode: "wand",
        label: "Aim + physical casting",
        gestures: { swing: "spell.cast.blade", shake: "spell.cast.shield", spin: "spell.cast.vortex" },
      },
      layout: [
        { type: "touch-surface", action: "spell.aim", label: "ARCANE AIM" },
        { type: "button", action: "spell.cast.projectile", label: "PROJECTILE", emphasis: "primary" },
        { type: "button", action: "spell.cast.shield", label: "SHIELD" },
        { type: "button", action: "spell.cast.grab", label: "GRAB" },
        { type: "button", action: "spell.cast.blade", label: "BLADE" },
        { type: "button", action: "spell.cast.charge", label: "CHARGE" },
        { type: "button", action: "spell.cast.vortex", label: "VORTEX", emphasis: "danger" }
      ]
    }
  }
];
