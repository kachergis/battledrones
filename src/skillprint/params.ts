/**
 * The knobs Skillprint can turn (ADJUST_GAME), in skillprint-js-sdk's
 * ParameterDefinition shape: tools/skillprint-manifest.ts writes them into the
 * portal's parameter manifest, so the backend, the portal's 1–9 tester and the
 * game all use these names.
 *
 * Mid-match, the AI's knobs change only which orders its commander gives
 * (and those are in the battle record), and the income knobs go through the
 * sim as a recorded `tune` command: a replay of an adjusted match plays as it
 * was played. aiDifficulty picks the next match's commander.
 */
import { DIFFICULTY, type AiTuning, type Difficulty } from "../sim/ai/commander";
import { TUNE_INCOME } from "../sim/sim";

export interface ParameterDefinition {
  parameterName: string;
  type: "Float" | "Integer" | "Boolean";
  min: number;
  max: number;
  default: number;
  description: string;
  /** How a raised value plays (the scorer's adjustment instructions start from this). */
  howSdkChangesIt: string;
}

const NORMAL = DIFFICULTY.normal;
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "normal", "hard"];

export const PARAMETERS: readonly ParameterDefinition[] = [
  {
    parameterName: "aiIncomeMult",
    type: "Float",
    min: 0.5,
    max: 1.6,
    default: NORMAL.incomeMult,
    description: "The enemy commander's income: scrap from harvesting, Uplinks and salvage is multiplied by this (Easy 0.75, Normal 1, Hard 1.3).",
    howSdkChangesIt: "Higher: a richer enemy fields bigger armies sooner (harder). Lower: a poorer, smaller enemy (easier). Takes effect at once."
  },
  {
    parameterName: "aiReactionSec",
    type: "Float",
    min: 0.8,
    max: 5,
    default: NORMAL.interval,
    description: "Seconds between the enemy commander's decision passes: building, producing, scouting and sending waves (Easy 3.5, Normal 2, Hard 1.2).",
    howSdkChangesIt: "Higher: a slower, less responsive enemy (easier). Lower: it reacts and expands faster (harder). Takes effect at its next decision."
  },
  {
    parameterName: "aiAssaultMult",
    type: "Float",
    min: 0.6,
    max: 2,
    default: NORMAL.assaultMult,
    description: "How big an army the enemy masses before an all-in attack, as a multiple of its personality's threshold (Easy 1.35, Normal 1, Hard 0.9).",
    howSdkChangesIt: "Higher: fewer, later, larger attacks, so more time to build up (easier, calmer). Lower: earlier and more frequent pressure (harder, more intense)."
  },
  {
    parameterName: "playerIncomeMult",
    type: "Float",
    min: 0.5,
    max: 1.6,
    default: 1,
    description: "The player's income multiplier on harvested, Uplink and salvaged scrap.",
    howSdkChangesIt: "Higher: more scrap to build with and recover from mistakes (easier). Lower: a tighter economy that punishes waste (harder). Takes effect at once."
  },
  {
    parameterName: "aiDifficulty",
    type: "Integer",
    min: 0,
    max: 2,
    default: 1,
    description: "The next match's enemy commander: 0 Easy, 1 Normal, 2 Hard (its personality pool, reaction speed, income and aggression).",
    howSdkChangesIt: "Higher: a harder commander from the next match on. The match in progress keeps its commander (use the other knobs for that)."
  }
];

const BY_NAME = new Map(PARAMETERS.map((p) => [p.parameterName, p]));

/** `raw` as `name`'s value, clamped into its range (null: not a knob, or not a number). */
export function parameterValue(name: string, raw: unknown): number | null {
  const p = BY_NAME.get(name);
  const n = typeof raw === "boolean" ? Number(raw) : typeof raw === "string" ? Number(raw.trim()) : raw;
  if (!p || typeof n !== "number" || !Number.isFinite(n)) return null;
  const v = Math.min(p.max, Math.max(p.min, n));
  return p.type === "Float" ? v : Math.round(v);
}

/** What Skillprint has set so far this session (a knob it never touched is absent: the match's own value holds). */
export interface Tuning {
  ai: AiTuning;
  playerIncomeMult?: number;
  aiDifficulty?: Difficulty;
}

export const emptyTuning = (): Tuning => ({ ai: {} });

/** Set `name` in `t` (false: not a knob or not a number). */
export function applyParameter(t: Tuning, name: string, raw: unknown): boolean {
  const v = parameterValue(name, raw);
  if (v === null) return false;
  switch (name) {
    case "aiIncomeMult":
      t.ai.incomeMult = v;
      break;
    case "aiReactionSec":
      t.ai.interval = v;
      break;
    case "aiAssaultMult":
      t.ai.assaultMult = v;
      break;
    case "playerIncomeMult":
      t.playerIncomeMult = v;
      break;
    case "aiDifficulty":
      t.aiDifficulty = DIFFICULTIES[v]!;
      break;
  }
  return true;
}

// (the income knobs must fit what a tune command takes, or the sim would clamp them again)
for (const n of ["aiIncomeMult", "playerIncomeMult"]) {
  const p = BY_NAME.get(n)!;
  if (p.min < TUNE_INCOME.min || p.max > TUNE_INCOME.max) throw new Error(`${n} outside TUNE_INCOME`);
}
