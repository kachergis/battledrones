/**
 * What a match tells Skillprint, free of the DOM so tests can drive it
 * (tests/skillprint.test.ts). The bridge (bridge.ts) posts its messages to
 * the portal page around the game.
 *
 *  - `gameEvent`s, at most a few a second: the universal GAME_START /
 *    GAME_END / GAME_PAUSE / GAME_RESUME, and Battle Drones' own (EVENTS),
 *    all from the player's side of the battle.
 *  - A `gameState` every STATE_EVERY seconds of battle: the economy, the two
 *    armies, the map and the player's pace. What fires many times a tick
 *    (shots, hits, harvester trips, salvage) is only ever counted into it.
 */
import { BUILDINGS, TICK_RATE, UNITS } from "../sim/balance";
import { isOut } from "../sim/combat";
import { sidesOf } from "../sim/sides";
import type { Command, Faction, FxEvent, World } from "../sim/types";

/** Seconds of battle between `gameState`s. */
export const STATE_EVERY = 5;
/** Orders per minute are counted over this many trailing seconds of battle. */
const APM_WINDOW = 60;

/** Battle Drones' own events, with their fields (the GameSchema and the scorer's guidance come from this). */
export const EVENTS = {
  ORDER: { order: "string", units: "integer" },
  UNIT_PRODUCED: { unit: "string", cost: "integer" },
  BUILDING_COMPLETE: { building: "string", cost: "integer" },
  ENEMY_KILLED: { kind: "string", value: "integer", air: "boolean", isBuilding: "boolean" },
  UNIT_LOST: { unit: "string", value: "integer", air: "boolean" },
  BUILDING_LOST: { building: "string", value: "integer" },
  UNIT_PROMOTED: { unit: "string" },
  CALLDOWN: { power: "string" },
  ENEMY_CALLDOWN: { power: "string" },
  UPLINK_CAPTURED: { held: "integer" },
  UPLINK_LOST: { held: "integer" },
  CRATE_CLAIMED: { reward: "string", scrap: "integer" },
  WAVE_CLEARED: { wave: "integer", bonus: "integer" },
  SIDE_ELIMINATED: { side: "string", byPlayer: "boolean" }
} as const satisfies Record<string, Record<string, "string" | "integer" | "number" | "boolean">>;

export type EventName = keyof typeof EVENTS | "GAME_START" | "GAME_END" | "GAME_PAUSE" | "GAME_RESUME";

export type Message =
  | { type: "gameEvent"; data: { event: EventName; at: number } & Record<string, unknown> }
  | { type: "gameState"; data: GameState };

/** What a match is, for GAME_START. */
export interface MatchInfo {
  mode: "skirmish" | "survival" | "op" | "daily";
  map: string;
  biome: string;
  /** The commanders' difficulty (Last Stand: the waves'). */
  difficulty: string;
  /** The enemy commanders' personalities (none in Last Stand or a waves op). */
  aiStrategies: string[];
  mutators: string[];
  side: Faction;
  rivals: number;
  /** The player's opener card (absent: Last Stand and ops have none). */
  opener?: string;
}

export interface GameState {
  /** Seconds of battle. */
  time: number;
  scrap: number;
  /** Scrap earned per minute, over the last STATE_EVERY seconds. */
  incomePerMin: number;
  /** Scrap value of the player's units and of every rival's. */
  armyValue: number;
  enemyArmyValue: number;
  units: number;
  buildings: number;
  uplinksHeld: number;
  uplinksTotal: number;
  kills: number;
  losses: number;
  /** Scrap value killed and lost. */
  killValue: number;
  lossValue: number;
  /** Orders per minute over the last minute of battle. */
  apm: number;
  /** The game's speed setting (1–4×). */
  speed: number;
  isGameOver: boolean;
  /** At the end: won, lost, draw or resigned. */
  outcome?: string;
  /** At the end: career XP the match earned (the game's own points). */
  score?: number;
}

/**
 * One match's reporter. `clock` is epoch ms (the portal timestamps the
 * events with it), `speed` the game-speed setting.
 */
export class MatchReporter {
  private kills = 0;
  private losses = 0;
  private killValue = 0;
  private lossValue = 0;
  /** Ticks of the player's orders over the trailing APM_WINDOW. */
  private orderTicks: number[] = [];
  private earned = 0;
  private lastStateTick = 0;
  /** Uplink and crate scrap the last state had counted (objectives.ts keeps the running total). */
  private objectiveSeen = 0;
  private paused = false;
  private ended = false;
  private started = false;

  constructor(
    private readonly post: (m: Message) => void,
    private readonly side: Faction,
    private readonly clock: () => number,
    private readonly speed: () => number = () => 1
  ) {}

  get isOver(): boolean {
    return this.ended;
  }

  private event(event: EventName, data: Record<string, unknown> = {}): void {
    this.post({ type: "gameEvent", data: { event, at: this.clock(), ...data } });
  }

  /** The clock starts (after the opener). */
  start(w: World, info: MatchInfo): void {
    if (this.started) return;
    this.started = true;
    this.lastStateTick = w.tick;
    this.objectiveSeen = this.objectiveScrap(w);
    this.event("GAME_START", { ...info });
    this.state(w);
  }

  /** The player's orders as they were stepped. */
  orders(w: World, cmds: readonly Command[]): void {
    if (!this.started || this.ended) return;
    for (const c of cmds) {
      if (c.faction !== this.side || c.type === "tune") continue;
      this.orderTicks.push(w.tick);
      this.event("ORDER", { order: c.type, units: "unitIds" in c ? c.unitIds.length : 0 });
    }
  }

  /** A tick was stepped: its events, and a `gameState` when one is due. */
  tick(w: World): void {
    if (!this.started || this.ended) return;
    for (const ev of w.fx) this.onFx(w, ev);
    if (w.tick - this.lastStateTick >= STATE_EVERY * TICK_RATE) this.state(w);
  }

  pause(paused: boolean): void {
    if (!this.started || this.ended || paused === this.paused) return;
    this.paused = paused;
    this.event(paused ? "GAME_PAUSE" : "GAME_RESUME");
  }

  /** The match is decided (or left): GAME_END and the final state. `score`: the career XP it earned. */
  end(w: World, outcome: "won" | "lost" | "draw" | "resigned" | "left", score?: number): void {
    if (!this.started || this.ended) return;
    const final = this.state(w, { outcome, ...(score !== undefined ? { score } : {}) });
    this.ended = true;
    this.event("GAME_END", {
      outcome,
      time: final.time,
      kills: final.kills,
      losses: final.losses,
      killValue: final.killValue,
      lossValue: final.lossValue,
      ...(score !== undefined ? { score } : {})
    });
    this.post({ type: "gameState", data: { ...final, isGameOver: true } });
  }

  private onFx(w: World, ev: FxEvent): void {
    const me = this.side;
    switch (ev.type) {
      case "built": {
        if (ev.faction !== me) break;
        const u = w.units.get(ev.id);
        const b = u ? null : w.buildings.get(ev.id);
        if (u) this.event("UNIT_PRODUCED", { unit: u.kind, cost: UNITS[u.kind].cost });
        else if (b) this.event("BUILDING_COMPLETE", { building: b.kind, cost: BUILDINGS[b.kind].cost });
        break;
      }
      case "death": {
        const kind = ev.unitKind ?? ev.buildingKind ?? "unknown";
        if (ev.faction === me) {
          this.losses++;
          this.lossValue += ev.value;
          if (ev.unitKind) this.event("UNIT_LOST", { unit: kind, value: ev.value, air: ev.air });
          else this.event("BUILDING_LOST", { building: kind, value: ev.value });
        } else if (ev.by === me || (ev.by === undefined && sidesOf(w).length === 2)) {
          // (a duel credits every enemy death to us; a free-for-all only our own kills)
          this.kills++;
          this.killValue += ev.value;
          this.event("ENEMY_KILLED", { kind, value: ev.value, air: ev.air, isBuilding: !ev.unitKind });
        }
        break;
      }
      case "rankUp": {
        const u = w.units.get(ev.id);
        if (u?.faction === me) this.event("UNIT_PROMOTED", { unit: u.kind });
        break;
      }
      case "calldown":
        this.event(ev.faction === me ? "CALLDOWN" : "ENEMY_CALLDOWN", { power: ev.power });
        break;
      case "uplinkFlip":
        if (ev.owner === me) this.event("UPLINK_CAPTURED", { held: this.uplinksHeld(w) });
        else if (ev.prev === me) this.event("UPLINK_LOST", { held: this.uplinksHeld(w) });
        break;
      case "crateClaimed":
        if (ev.faction === me) this.event("CRATE_CLAIMED", { reward: ev.reward, scrap: Math.round(ev.scrap) });
        break;
      case "waveCleared":
        this.event("WAVE_CLEARED", { wave: ev.wave, bonus: Math.round(ev.bonus) });
        break;
      case "eliminated":
        if (ev.faction !== me) this.event("SIDE_ELIMINATED", { side: ev.faction, byPlayer: ev.by === me });
        break;
      case "deposit":
      case "salvage":
        if (ev.faction === me) this.earned += ev.type === "deposit" ? ev.amount : ev.value;
        break;
    }
  }

  private objectiveScrap(w: World): number {
    const s = w.objectives.stats[this.side];
    return s ? s.uplinkScrap + s.crateScrap : 0;
  }

  private uplinksHeld(w: World): number {
    return w.objectives.uplinks.filter((l) => l.owner === this.side).length;
  }

  /** Post the state now (and start the next interval). */
  private state(w: World, extra: Partial<GameState> = {}): GameState {
    const me = this.side;
    const f = w.factions[me];
    const secs = (w.tick - this.lastStateTick) / TICK_RATE;
    // income since the last state: harvests and salvage (their fx), plus Uplinks and crates (a running total)
    // (not the change in scrap: that is income less spending)
    const objective = this.objectiveScrap(w);
    const earned = this.earned + objective - this.objectiveSeen;
    this.objectiveSeen = objective;
    this.earned = 0;
    this.lastStateTick = w.tick;
    let armyValue = 0;
    let enemyArmyValue = 0;
    let units = 0;
    for (const u of w.units.values()) {
      if (u.kind === "harvester") {
        if (u.faction === me) units++;
        continue;
      }
      const v = UNITS[u.kind].cost;
      if (u.faction === me) {
        armyValue += v;
        units++;
      } else if (!isOut(w, u.faction)) enemyArmyValue += v;
    }
    let buildings = 0;
    for (const b of w.buildings.values()) if (b.faction === me) buildings++;
    const now = w.tick;
    this.orderTicks = this.orderTicks.filter((t) => now - t < APM_WINDOW * TICK_RATE);
    const window = Math.min(APM_WINDOW, Math.max(1, now / TICK_RATE));
    const s: GameState = {
      time: Math.round((now / TICK_RATE) * 10) / 10,
      scrap: Math.floor(f.scrap),
      incomePerMin: secs > 0 ? Math.round((Math.max(0, earned) / secs) * 60) : 0,
      armyValue,
      enemyArmyValue,
      units,
      buildings,
      uplinksHeld: this.uplinksHeld(w),
      uplinksTotal: w.objectives.uplinks.length,
      kills: this.kills,
      losses: this.losses,
      killValue: this.killValue,
      lossValue: this.lossValue,
      apm: Math.round((this.orderTicks.length / window) * 60),
      speed: this.speed(),
      isGameOver: false,
      ...extra
    };
    if (!extra.outcome) this.post({ type: "gameState", data: s });
    return s;
  }
}
