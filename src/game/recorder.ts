/**
 * The battle record of a match played here, against the AI or watched AI vs
 * AI (skirmish, the Daily Op, Last Stand and Ops): the end screen's "Copy
 * replay JSON" (ui/hud.ts). The sim is deterministic, so the record is the
 * setup the world was made from, every non-empty tick's commands as they were
 * stepped, and a world hash every HASH_EVERY ticks: 🎬 Watch a replay plays
 * it back exactly, and says so if it drifts (game/replay.ts).
 *
 * GameScene makes one for every match it sets up itself (a fed match, a duel
 * or a replay, has a record of its own: MatchFeed.battleRecord), tells it the
 * openers, and hands it each tick's commands right after step().
 *
 * Where the spec is silent:
 *  - the setup is what GameScene made the world with (its MatchOptions), so
 *    a Last Stand or an op is set up again the same way (sim/setup.ts
 *    setupWorld takes `survival` and `op` for it);
 *  - the built-in AI's income handicap (tickAi sets it every tick, from the
 *    first) goes into `income`, read off the world when the record is made;
 *  - the seats say who played: "player" for this phone, "ai:<strategy>:
 *    <difficulty>" for a commander, "waves:<difficulty>" for Last Stand's
 *    director, "op:<id>" for an op's enemy;
 *  - commands are copied as they are stepped: the Controller may keep
 *    references to the arrays it sent;
 *  - a match not decided (the record is made mid-match) has no end, and its
 *    `tick` says how far it was played.
 */
// (types only from the arena: the viewer and the arena load on demand, tests/arena.test.ts)
import type { BattleEnd, BattleRecord, SeatInfo } from "../arena/record";
import { worldHash } from "../sim/checksum";
import type { MatchOptions } from "../sim/maps";
import type { OpenerId } from "../sim/openers";
import type { Command, Faction, World } from "../sim/types";
import { sidesOf } from "../sim/sides";

declare const __SIM_HASH__: string | undefined;
/** The sim this build plays (vite.config.ts), or null outside a Vite build (tests). */
const BUILD_SIM: string | null = typeof __SIM_HASH__ === "undefined" ? null : __SIM_HASH__;


/** A world hash goes into the record every this many ticks: the arena's rate (arena/record.ts HASH_EVERY), which the viewer checks. */
export const HASH_EVERY = 100;

/**
 * How a decided world ends its record: arena/record.ts endOf, which this
 * may not import (tests/resign.test.ts holds the two together).
 */
export function recordEnd(tick: number, winner: Faction | "draw", resigned?: Faction | null): BattleEnd {
  if (winner === "draw") return { tick, winner: null, reason: resigned === null ? "resign" : "love" };
  return { tick, winner, reason: resigned ? "resign" : "hq" };
}

/** Each side's income multiplier, where it isn't 1. */
function incomeOf(w: World): Partial<Record<Faction, number>> {
  const income: Partial<Record<Faction, number>> = {};
  for (const f of sidesOf(w)) if (w.factions[f].incomeMult !== 1) income[f] = w.factions[f].incomeMult;
  return income;
}

export class MatchRecorder {
  private openers: Partial<Record<Faction, OpenerId>> = {};
  private readonly turns: [number, Faction, Command[]][] = [];
  private readonly hashes: [number, string][] = [];
  private readonly created = new Date().toISOString();
  /** Each side's income multiplier as the match began: a `tune` command changes it later, in the turns. */
  private income: Partial<Record<Faction, number>> | null = null;

  constructor(
    private readonly map: string,
    private readonly opts: MatchOptions,
    private readonly seats: Partial<Record<Faction, SeatInfo>>
  ) {}

  /** The openers each side was dealt (before tick 0). */
  setOpeners(picks: Partial<Record<Faction, OpenerId>>): void {
    this.openers = { ...picks };
  }

  /** Tick `w.tick - 1` was just stepped with `cmds`. */
  stepped(w: World, cmds: readonly Command[]): void {
    const t = w.tick - 1;
    // (after the first tick: a tune on it is in the turns as well, and setting it twice is setting it once)
    this.income ??= incomeOf(w);
    for (const side of sidesOf(w)) {
      const theirs = cmds.filter((c) => c.faction === side);
      if (theirs.length) this.turns.push([t, side, structuredClone(theirs)]);
    }
    if (w.tick % HASH_EVERY === 0) this.hashes.push([w.tick, worldHash(w)]);
  }

  /** The record of the match so far. */
  record(w: World): BattleRecord {
    const income = this.income ?? incomeOf(w);
    const end = w.winner ? recordEnd(w.tick, w.winner, w.resigned) : null;
    const o = this.opts;
    return {
      v: 1,
      commit: null,
      sim: BUILD_SIM,
      created: this.created,
      map: this.map,
      mutators: o.mutators?.slice() ?? [],
      seed: w.seed,
      round: 1,
      maxTicks: w.tick,
      openers: { ...this.openers },
      ...(Object.keys(income).length ? { income } : {}),
      ...(o.survival ? { survival: { ...o.survival } } : {}),
      ...(o.op ? { op: o.op } : {}),
      seats: Object.fromEntries(sidesOf(w).map((f) => [f, { ...this.seats[f] }])) as BattleRecord["seats"],
      frames: "own",
      turns: this.turns.map(([t, f, c]) => [t, f, c]),
      radio: [],
      hashes: this.hashes.slice(),
      log: [],
      tick: w.tick,
      end,
      usage: {}
    };
  }
}
