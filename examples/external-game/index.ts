import { Game101, type GameControllerRole } from "@101/sdk";
import input from "./input.manifest.json" with { type: "json" };
import manifest from "./manifest.json" with { type: "json" };
import { meteorDash } from "./game.ts";

const controllers = [{
  id: "pilot", label: "Pilot", playerId: "player-1",
  requiredCapabilities: ["touch"], preferredCapabilities: ["haptics"],
  layout: {
    title: "Meteor Dash", accent: "#50e3ff",
    layout: [
      { type: "joystick", action: "move", label: "FLIGHT" },
      { type: "button", action: "boost", label: "BOOST", emphasis: "primary" },
    ],
  },
}] as const satisfies readonly GameControllerRole[];

export default Game101.package({ manifest, input, controllers, game: meteorDash });
