/**
 * Battle Drones' link to Skillprint. In the Skillprint portal the page around
 * the game owns the session (it runs skillprint-js-sdk): the game posts it
 * what happens (report.ts), a frame of the battle every FRAME_SECONDS, and
 * GAME_COMPLETE from the end screen's Finish button, and takes ADJUST_GAME
 * (params.ts), GAME_PAUSE and GAME_RESUME. Anywhere else (no parent page)
 * it does nothing; `?skillprint=log` logs the messages instead, for testing.
 *
 * Only a match the player plays against the AI reports: a skirmish, Last
 * Stand, an op or the Daily Op. Duels, free-for-alls online, watching AIs
 * and replays don't (GameScene decides).
 */
import type { AiTuning } from "../sim/ai/commander";
import type { Faction, World, Command } from "../sim/types";
import { DIFFICULTIES, applyParameter, emptyTuning, type Tuning } from "./params";
import { MatchReporter, type GameState, type MatchInfo, type Message } from "./report";

const FRAME_SECONDS = 2;
/** The knobs set this session survive the page reloading (the end screen's Rematch and Menu reload it). */
const TUNING_KEY = "battledrones.skillprint.tuning";
const FRAME_WIDTH = 1024;

const epochMs = (now = performance.now()): number => performance.timeOrigin + now;

/** What the bridge needs from the match in progress (GameScene). */
export interface MatchPort {
  readonly world: World;
  /** Override the enemy commanders' knobs (their income through a recorded `tune`). */
  tuneAi(t: AiTuning): void;
  /** The player's income multiplier, through a recorded `tune`. */
  tunePlayerIncome(m: number): void;
  setPaused(paused: boolean): void;
  /** The game-speed setting (1–4×). */
  speed(): number;
}

/** Outgoing messages: to the portal, or the console (`?skillprint=log`). */
type Sink = (m: Message | ({ type: string } & Record<string, unknown>)) => void;

export class SkillprintBridge {
  readonly tuning: Tuning;
  private link: MatchLink | null = null;

  constructor(private readonly send: Sink, private readonly log: boolean) {
    this.tuning = loadTuning();
  }

  /** The bridge for this page: embedded in a page (the portal), or `?skillprint=log`; else null. */
  static attach(): SkillprintBridge | null {
    const embedded = window.parent !== window;
    const log = new URLSearchParams(location.search).get("skillprint") === "log";
    if (!embedded && !log) return null;
    const send: Sink = embedded
      ? (m) => window.parent.postMessage(m, "*")
      : (m) => console.debug("[skillprint]", m.type, "data" in m ? m.data : "");
    const bridge = new SkillprintBridge(send, log);
    window.addEventListener("message", (e) => {
      // (only the page around the game adjusts it)
      if (embedded && e.source !== window.parent) return;
      bridge.receive(e.data);
    });
    if (embedded)
      // keys 1-9 also belong to the portal's adjustment tester (1-3 still select squads here)
      window.addEventListener(
        "keydown",
        (e) => {
          if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey)
            window.parent.postMessage({ type: "skillprint_keydown", key: e.key }, "*");
        },
        true
      );
    // (tests and the iframe harness read and drive it here)
    (window as unknown as { __skillprint?: SkillprintBridge }).__skillprint = bridge;
    return bridge;
  }

  /** A message from the portal. */
  receive(msg: unknown): void {
    const { type, data } = (msg ?? {}) as { type?: string; data?: { parameterName?: unknown; parameterValue?: unknown } };
    if (type === "ADJUST_GAME" && typeof data?.parameterName === "string") this.adjust(data.parameterName, data.parameterValue);
    else if (type === "GAME_PAUSE") this.link?.port.setPaused(true);
    else if (type === "GAME_RESUME") this.link?.port.setPaused(false);
  }

  /** Set a knob: from now on in this match (where it can change mid-match), and in every match after. */
  adjust(name: string, value: unknown): boolean {
    if (!applyParameter(this.tuning, name, value)) {
      console.warn(`[skillprint] ignored adjustment ${name} = ${String(value)}`);
      return false;
    }
    if (this.log) console.info(`[skillprint] ${name} = ${String(value)}`);
    saveTuning(this.tuning);
    const port = this.link?.port;
    if (!port || name === "aiDifficulty") return true; // (the next match's commanders: GameScene asks for it)
    const ai = this.tuning.ai;
    if (name === "playerIncomeMult") port.tunePlayerIncome(this.tuning.playerIncomeMult!);
    // (just the knob that changed: an income tune goes into the battle record only when the income did)
    else if (name === "aiIncomeMult") port.tuneAi({ incomeMult: ai.incomeMult! });
    else if (name === "aiReactionSec") port.tuneAi({ interval: ai.interval! });
    else if (name === "aiAssaultMult") port.tuneAi({ assaultMult: ai.assaultMult! });
    return true;
  }

  /** A match the player is about to play against the AI: report it, and apply the knobs set so far. */
  match(port: MatchPort, side: Faction, info: () => MatchInfo): MatchLink {
    const link = new MatchLink(this.send, port, side, info);
    this.link = link;
    if (Object.keys(this.tuning.ai).length) port.tuneAi({ ...this.tuning.ai });
    if (this.tuning.playerIncomeMult !== undefined) port.tunePlayerIncome(this.tuning.playerIncomeMult);
    return link;
  }
}

function loadTuning(): Tuning {
  const t = emptyTuning();
  try {
    const saved = JSON.parse(sessionStorage.getItem(TUNING_KEY) ?? "{}") as Record<string, unknown>;
    for (const [name, v] of Object.entries(saved)) applyParameter(t, name, v);
  } catch {
    /* storage unavailable: start from the game's own values */
  }
  return t;
}

function saveTuning(t: Tuning): void {
  const values: Record<string, number | string> = {};
  if (t.ai.incomeMult !== undefined) values.aiIncomeMult = t.ai.incomeMult;
  if (t.ai.interval !== undefined) values.aiReactionSec = t.ai.interval;
  if (t.ai.assaultMult !== undefined) values.aiAssaultMult = t.ai.assaultMult;
  if (t.playerIncomeMult !== undefined) values.playerIncomeMult = t.playerIncomeMult;
  if (t.aiDifficulty !== undefined) values.aiDifficulty = DIFFICULTIES.indexOf(t.aiDifficulty);
  try {
    sessionStorage.setItem(TUNING_KEY, JSON.stringify(values));
  } catch {
    /* storage unavailable: this page keeps them */
  }
}

/** One match's link to the portal: its reporter, and its frames. */
export class MatchLink {
  private readonly reporter: MatchReporter;
  private last: GameState | null = null;
  private lastFrame = -Infinity;
  private composing = false;
  private readonly work = document.createElement("canvas");
  private outcome: { outcome: string; score?: number } | null = null;

  constructor(
    private readonly send: Sink,
    readonly port: MatchPort,
    side: Faction,
    private readonly info: () => MatchInfo
  ) {
    this.reporter = new MatchReporter(
      (m) => {
        if (m.type === "gameState") this.last = m.data;
        send(m);
      },
      side,
      () => epochMs(),
      () => port.speed()
    );
  }

  /** A tick was stepped with `cmds` (the first one starts the match's report). */
  stepped(cmds: readonly Command[]): void {
    const w = this.port.world;
    this.reporter.start(w, this.info()); // (once)
    this.reporter.orders(w, cmds);
    this.reporter.tick(w);
  }

  pause(paused: boolean): void {
    this.reporter.pause(paused);
  }

  /** Decided: `score` is the career XP the match earned. */
  end(outcome: "won" | "lost" | "draw" | "resigned", score?: number): void {
    this.reporter.end(this.port.world, outcome, score);
    this.outcome = { outcome, ...(score !== undefined ? { score } : {}) };
  }

  /** The end screen's Finish button: the portal ends the session and shows the player's results. */
  endActions(): { id: string; label: string; cls?: string; on(): void }[] {
    return [
      {
        id: "skillprint-finish",
        label: "📊 Finish: see your results",
        on: () => this.send({ type: "GAME_COMPLETE", data: { ...this.outcome, time: this.last?.time ?? 0 } })
      }
    ];
  }

  /**
   * Right after the 3D view rendered `now` (performance.now()), while its
   * drawing buffer still holds the frame (it isn't preserved: any later and
   * the capture is blank). Every FRAME_SECONDS during the battle.
   */
  frame(now: number, view: HTMLCanvasElement, overlay: HTMLCanvasElement | null): void {
    if (this.reporter.isOver || this.composing || now - this.lastFrame < FRAME_SECONDS * 1000) return;
    if (!this.last) return; // (the battle hasn't started: the opener cards are up)
    this.lastFrame = now;
    const scale = Math.min(1, FRAME_WIDTH / view.width);
    const w = Math.round(view.width * scale);
    const h = Math.round(view.height * scale);
    const work = this.work;
    work.width = w;
    work.height = h;
    const ctx = work.getContext("2d");
    if (!ctx || w === 0 || h === 0) return;
    ctx.drawImage(view, 0, 0, w, h);
    if (overlay) ctx.drawImage(overlay, 0, 0, w, h); // health bars and labels
    stamp(ctx, describe(this.last), w);
    this.composing = true;
    // toBlob encodes off the main thread; toDataURL would stall the battle a frame or three
    work.toBlob(
      (blob) => {
        if (!blob) {
          this.composing = false;
          return;
        }
        const fr = new FileReader();
        fr.onload = () => {
          this.composing = false;
          this.send({ type: "screenshot", dataUrl: fr.result, capturedAt: epochMs(now) });
        };
        fr.onerror = () => (this.composing = false);
        fr.readAsDataURL(blob);
      },
      "image/jpeg",
      0.8
    );
  }
}

/** The HUD the scorer can't see (it's HTML, not in the canvas), as lines stamped on the frame. */
function describe(s: GameState): string[] {
  const t = Math.floor(s.time);
  return [
    `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}  scrap ${s.scrap} (+${s.incomePerMin}/min)`,
    `army ${s.armyValue} vs ${s.enemyArmyValue}  units ${s.units}  buildings ${s.buildings}`,
    `kills ${s.kills}  losses ${s.losses}  uplinks ${s.uplinksHeld}/${s.uplinksTotal}  apm ${s.apm}`
  ];
}

function stamp(ctx: CanvasRenderingContext2D, lines: string[], w: number): void {
  const size = Math.max(12, Math.round(w / 64));
  ctx.font = `500 ${size}px ui-monospace, Menlo, monospace`;
  const pad = Math.round(size * 0.6);
  const lh = Math.round(size * 1.35);
  const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  ctx.fillStyle = "rgba(12, 16, 28, 0.72)";
  ctx.fillRect(0, 0, bw, lines.length * lh + pad * 2 - (lh - size));
  ctx.fillStyle = "#f5ecda";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, pad, pad + i * lh));
}

/** This page's bridge (null: not embedded, nothing reports). */
export const skillprint: SkillprintBridge | null = typeof window === "undefined" ? null : SkillprintBridge.attach();
