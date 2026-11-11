# Skillprint

Battle Drones can be played inside the [Skillprint](https://skillprint.co)
portal (`skillprint/fe-refactor`), which scores players' skills and mood from
what the game reports and adjusts its difficulty as they play. Everything for
it is in [`src/skillprint/`](src/skillprint/). Outside the portal it does
nothing: the bridge attaches only when the page is inside another page (or
with `?skillprint=log`, which logs what it would post to the console).

## What the game reports

Only a match the player plays against the AI reports: a skirmish, Last
Stand, an op or the Daily Op. Duels, online free-for-alls, AI-vs-AI and
replays don't. The portal owns the session (it runs `skillprint-js-sdk`), so
the game only posts messages to it:

- `gameEvent`s ([`report.ts`](src/skillprint/report.ts)): GAME_START,
  GAME_END, GAME_PAUSE, GAME_RESUME, and Battle Drones' own (ORDER,
  UNIT_PRODUCED, ENEMY_KILLED, UPLINK_CAPTURED, …) from the player's side of
  the battle. Shots, hits and harvester trips are only ever counted.
- a `gameState` every 5 s of battle: scrap, income, both armies' value,
  kills, losses, Uplinks held, orders per minute. The last one carries the
  outcome and the career XP the match earned as its `score`.
- a `screenshot` every 2 s, with the HUD's numbers stamped on it (the HUD is
  HTML, so it isn't in the canvas).
- `GAME_COMPLETE` from the end screen's 📊 Finish button.

## What Skillprint can adjust

`ADJUST_GAME` sets the knobs in [`params.ts`](src/skillprint/params.ts): the
enemy commander's income, reaction time and attack threshold, the player's
income, and the next match's difficulty. They hold for the rest of the
session, across the page reloads Rematch and Menu do.

The sim is deterministic and a match's battle record replays it from its
orders, so a knob may never change the world behind the record's back. The
commander's knobs change only which orders it gives, and those are in the
record already. The income knobs go through the sim as a `tune` command,
recorded like any order. **📋 Copy replay JSON** still replays an adjusted
match exactly (`tests/skillprint.test.ts`, `tools/skillprint-smoke.mjs`). A
duel never sends a `tune`: its wire codec refuses one.

## Working on it

```bash
npm run build:portal          # the portal's copy: no service worker, no reference pages
npm run skillprint:smoke      # plays a match in skillprint-harness.html and checks every message
npm run skillprint:portal     # copies the build into ../fe-refactor/public/games/live/Battle Drones/
npx vite-node tools/skillprint-spec.ts   # events and knobs as JSON, for mcp-tools
```

[`skillprint-harness.html`](skillprint-harness.html) plays the portal's part:
open it from `npm run dev` to watch the messages and send the 1–9 presets.
The portal ships it as `static/iframeTest.html`.

`.mcp.json` registers the Skillprint MCP servers from a sibling
`mcp-tools` checkout (its `.venv`, set up as its README says).
`tools/skillprint-spec.ts` is their input: `scaffold_instrumentation` turns
it into the backend's GameSchema, `scoring_mcp` checks the manifest and
drafts the scorer's event guidance (the reviewed drafts are in
[`guidance.ts`](src/skillprint/guidance.ts)), and `game_publish_mcp`
creates the backend record that puts the game in the portal. Their static
check of the portal shim can't read the knob names out of a minified Vite
bundle, so it asks for them to be checked by hand. The smoke test is that
check.
