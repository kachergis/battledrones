/**
 * Battle Drones' Skillprint contract as JSON: every event it posts with its
 * fields, and every knob (src/skillprint/). The shape mcp-tools'
 * scaffold_instrumentation and scoring_mcp take (events: {name, fields};
 * parameters: {name, type, min, max, default, description,
 * how_sdk_changes_it}), so the portal's parameter manifest and the backend's
 * GameSchema come from the same names the game uses.
 *
 * Usage: npx vite-node tools/skillprint-spec.ts > spec.json
 */
import { PARAMETERS } from "../src/skillprint/params";
import { EVENTS } from "../src/skillprint/report";

/** The universal events' fields, as report.ts posts them. */
const UNIVERSAL = {
  GAME_START: {
    mode: "string", map: "string", biome: "string", difficulty: "string", aiStrategies: "array", mutators: "array",
    side: "string", rivals: "integer", opener: "string"
  },
  GAME_END: {
    outcome: "string", time: "number", kills: "integer", losses: "integer", killValue: "integer", lossValue: "integer", score: "integer"
  },
  GAME_PAUSE: {},
  GAME_RESUME: {}
};

const spec = {
  game_name: "Battle Drones",
  game_slug: "battle-drones",
  game_dir: "Battle Drones",
  events: Object.entries({ ...UNIVERSAL, ...EVENTS }).map(([name, fields]) => ({ name, fields })),
  parameters: PARAMETERS.map((p) => ({
    name: p.parameterName,
    type: p.type,
    min: p.min,
    max: p.max,
    default: p.default,
    description: p.description,
    how_sdk_changes_it: p.howSdkChangesIt
  }))
};

process.stdout.write(JSON.stringify(spec, null, 2) + "\n");
