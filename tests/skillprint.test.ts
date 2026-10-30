import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { replay } from "../src/arena/record";
import { applyOpenersCanonical, composeTick } from "../src/game/local-side";
import { MatchRecorder } from "../src/game/recorder";
import { createAiState, tickAi } from "../src/sim/ai/commander";
import { TICK_RATE } from "../src/sim/balance";
import { worldHash } from "../src/sim/checksum";
import { createMapWorld } from "../src/sim/maps";
import { allowedOpener, pickAiOpener } from "../src/sim/openers";
import { TUNE_INCOME, step } from "../src/sim/sim";
import type { Command, Faction, FxEvent } from "../src/sim/types";
import { BitWriter, encodeCommand } from "../src/versus/codec";
import { PARAMETERS, applyParameter, emptyTuning, parameterValue } from "../src/skillprint/params";
import { EVENTS, MatchReporter, STATE_EVERY, type MatchInfo, type Message } from "../src/skillprint/report";

describe("Skillprint's knobs (params.ts)", () => {
  it("clamps into range, rounds Integers, and refuses what isn't a knob or a number", () => {
    expect(parameterValue("aiIncomeMult", 9)).toBe(1.6);
    expect(parameterValue("aiReactionSec", "0.1")).toBe(0.8);
    expect(parameterValue("aiDifficulty", 1.6)).toBe(2);
    expect(parameterValue("aiDifficulty", -3)).toBe(0);
    expect(parameterValue("nope", 1)).toBeNull();
    expect(parameterValue("aiIncomeMult", "lots")).toBeNull();
    expect(parameterValue("aiIncomeMult", NaN)).toBeNull();
  });

  it("every knob's default is in its range, and each one lands somewhere", () => {
    for (const p of PARAMETERS) {
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
      const t = emptyTuning();
      expect(applyParameter(t, p.parameterName, p.max)).toBe(true);
      expect(t).not.toEqual(emptyTuning());
    }
    const t = emptyTuning();
    applyParameter(t, "aiDifficulty", 0);
    applyParameter(t, "aiReactionSec", 3);
    expect(t).toEqual({ ai: { interval: 3 }, aiDifficulty: "easy" });
  });
});

describe("the harness's 1-9 presets (skillprint-harness.html, the portal's GameAdjustmentTester)", () => {
  it("name only knobs, with values in range", () => {
    const html = readFileSync(new URL("../skillprint-harness.html", import.meta.url), "utf8");
    const block = /const PRESETS = (\{[\s\S]*?\n  \});/.exec(html)?.[1];
    expect(block).toBeTruthy();
    const presets = new Function(`return ${block}`)() as Record<string, { label: string; adjust: Record<string, number> }>;
    expect(Object.keys(presets)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    for (const { adjust } of Object.values(presets))
      for (const [name, v] of Object.entries(adjust)) expect([name, parameterValue(name, v)]).toEqual([name, v]);
  });
});

describe("the tune command", () => {
  it("sets a side's income multiplier, clamped", () => {
    const w = createMapWorld("riverlands", { seed: 5, objectives: true });
    step(w, [{ type: "tune", faction: "blue", incomeMult: 1.4 }]);
    expect(w.factions.blue.incomeMult).toBe(1.4);
    step(w, [{ type: "tune", faction: "red", incomeMult: 99 }]);
    expect(w.factions.red.incomeMult).toBe(TUNE_INCOME.max);
  });

  it("never goes on a duel's wire", () => {
    expect(() => encodeCommand(new BitWriter(), { type: "tune", faction: "blue", incomeMult: 1 }, { width: 64, height: 64 }, null)).toThrow();
  });

  it("a match tuned mid-battle replays exactly, and its record starts from the income it began with", () => {
    const opts = { seed: 77, objectives: true };
    const w = createMapWorld("riverlands", opts);
    const blue = createAiState("balanced", "normal", 3);
    const red = createAiState("rush", "hard", 4);
    const rec = new MatchRecorder(w.mapId, opts, { blue: { player: "ai" }, red: { player: "ai" } });
    const picks: Partial<Record<Faction, ReturnType<typeof pickAiOpener>>> = {};
    for (const [f, s] of [["blue", blue], ["red", red]] as const) {
      const pick = allowedOpener(w, f, pickAiOpener(s.strategy.name, w.seed, f));
      if (pick) picks[f] = pick;
    }
    applyOpenersCanonical(w, picks);
    rec.setOpeners(picks);
    while (w.tick < 1800 && !w.winner) {
      const tunes: Command[] = [];
      // as GameScene does it: the commander's override and a recorded tune, at 40 s and 100 s
      if (w.tick === 400) {
        red.tuning = { incomeMult: 0.6, interval: 4, assaultMult: 1.8 };
        tunes.push({ type: "tune", faction: "red", incomeMult: 0.6 });
      }
      // (blue has a commander here too, so it's tuned like one; the player's side never has one)
      if (w.tick === 1000) {
        blue.tuning = { incomeMult: 1.5 };
        tunes.push({ type: "tune", faction: "blue", incomeMult: 1.5 });
      }
      const cmds = composeTick("blue", tickAi(w, "blue", blue), tickAi(w, "red", red)).concat(tunes);
      step(w, cmds);
      rec.stepped(w, cmds);
    }
    expect(w.factions.red.incomeMult).toBe(0.6);
    expect(w.factions.blue.incomeMult).toBe(1.5);
    const record = rec.record(w);
    expect(record.income).toEqual({ red: 1.3 }); // (Hard, as it began)
    const r = replay(JSON.parse(JSON.stringify(record)));
    expect(r.divergedAt).toBeNull();
    expect(worldHash(r.world)).toBe(worldHash(w));
  });
});

describe("the match reporter (report.ts)", () => {
  function setup() {
    const w = createMapWorld("riverlands", { seed: 9, objectives: true });
    const out: Message[] = [];
    let now = 1_000;
    const r = new MatchReporter((m) => out.push(m), "blue", () => now++, () => 2);
    const events = () => out.filter((m) => m.type === "gameEvent").map((m) => m.data.event);
    const states = () => out.filter((m) => m.type === "gameState").map((m) => m.data);
    return { w, r, out, events, states };
  }
  const info: MatchInfo = { mode: "skirmish", map: "riverlands", biome: "temperate", difficulty: "normal", aiStrategies: ["rush"], mutators: [], side: "blue", rivals: 1 };

  it("reports nothing until the battle starts, then GAME_START once", () => {
    const { w, r, events } = setup();
    r.tick(w);
    r.orders(w, [{ type: "stop", faction: "blue", unitIds: [1] }]);
    expect(events()).toEqual([]);
    r.start(w, info);
    r.start(w, info);
    expect(events()).toEqual(["GAME_START"]);
  });

  it("the player's orders and their side of the battle's events, not the enemy's", () => {
    const { w, r, out, events } = setup();
    r.start(w, info);
    r.orders(w, [
      { type: "move", faction: "blue", unitIds: [1, 2, 3], x: 4, y: 4 },
      { type: "move", faction: "red", unitIds: [9], x: 4, y: 4 },
      { type: "tune", faction: "blue", incomeMult: 1.2 }
    ]);
    const death = (faction: Faction, value: number): FxEvent => ({
      type: "death", id: 0, faction, unitKind: "stinger", buildingKind: null, x: 0, y: 0, air: false, value,
      killerId: null, killerKind: null, rank: 0, kills: 0
    });
    w.fx = [
      death("red", 150),
      death("blue", 150),
      { type: "calldown", id: 1, faction: "red", power: "barrage", x: 1, y: 1, radius: 2, landTick: 9 },
      { type: "shot", fx: "bullet", x: 0, y: 0, tx: 1, ty: 1, fromAir: false, air: false, sourceId: 1 } as unknown as FxEvent
    ];
    r.tick(w);
    expect(events()).toEqual(["GAME_START", "ORDER", "ENEMY_KILLED", "UNIT_LOST", "ENEMY_CALLDOWN"]);
    const order = out.find((m): m is Extract<Message, { type: "gameEvent" }> => m.type === "gameEvent" && m.data.event === "ORDER")!;
    expect(order.data).toMatchObject({ order: "move", units: 3 });
    expect(typeof order.data.at).toBe("number");
    for (const m of out)
      if (m.type === "gameEvent" && m.data.event in EVENTS)
        for (const k of Object.keys(m.data)) if (k !== "event" && k !== "at") expect(EVENTS[m.data.event as keyof typeof EVENTS]).toHaveProperty(k);
  });

  it("a gameState every STATE_EVERY seconds of battle, and a last one at the end", () => {
    const { w, r, states, events } = setup();
    r.start(w, info);
    expect(states()).toHaveLength(1);
    for (let i = 0; i < STATE_EVERY * TICK_RATE * 2; i++) {
      step(w, []);
      r.tick(w);
    }
    expect(states()).toHaveLength(3);
    expect(states()[2]).toMatchObject({ time: STATE_EVERY * 2, speed: 2, isGameOver: false, units: expect.any(Number) });
    r.pause(true);
    r.pause(true);
    r.pause(false);
    r.end(w, "won", 120);
    r.end(w, "lost");
    step(w, []);
    r.tick(w);
    expect(events()).toEqual(["GAME_START", "GAME_PAUSE", "GAME_RESUME", "GAME_END"]);
    expect(states().at(-1)).toMatchObject({ isGameOver: true, outcome: "won", score: 120 });
  });
});
