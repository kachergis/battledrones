/**
 * What the Skillprint backend's LLMs are told about Battle Drones: how to
 * turn the knobs (params.ts) toward a mood or a skill, and how to read the
 * game's own events (report.ts) as evidence of skill. tools/skillprint-portal.ts
 * writes the first two into the portal's game-scoring-config.json; the third
 * is GameScoringConfig.event_skill_guidance (marketplace#125), applied through
 * mcp-tools' scoring_mcp.
 *
 * PROPOSAL, for review: the skills named here (planning, task-switching,
 * attention, perceptual-speed, spatial, action) are a proposed mapping. The
 * game isn't in the catalog yet, so none is mapped.
 */

export const ADJUSTMENT_INSTRUCTIONS = `You are adjusting parameters for Battle Drones, a real-time strategy game in the style of Command & Conquer, played against an AI commander.
The player harvests scrap with harvesters, builds a base (Fab Plant, Airpad, Assembly Bay, Tech Lab, turrets and more), trains an army of ground vehicles, drones and robot infantry, captures Uplink relays for income, and destroys the enemy HQ. The enemy commander plays by the same rules: every few seconds it decides what to build, when to scout, and when it has massed enough to attack. A match lasts roughly 4 to 15 minutes.

Each frame shows the battlefield from above, with the player's units in their own colour and health bars over anything damaged; the top left is stamped with the match clock, scrap and income per minute, both armies' value, unit and building counts, kills, losses, Uplinks held and orders per minute. A gameState every 5 s carries the same numbers. Events: GAME_START (map, difficulty, opener), ORDER (each order the player gives), UNIT_PRODUCED, BUILDING_COMPLETE, ENEMY_KILLED, UNIT_LOST, BUILDING_LOST, UNIT_PROMOTED, CALLDOWN and ENEMY_CALLDOWN (artillery, EMP, drop pods, orbital strikes), UPLINK_CAPTURED and UPLINK_LOST, CRATE_CLAIMED, WAVE_CLEARED (Last Stand) and GAME_END (won, lost, draw or resigned).

Five parameters are exposed:
- aiIncomeMult (number, 0.5-1.6, default 1): the enemy's income. Higher is harder: a richer enemy fields bigger armies sooner. Applies at once.
- aiReactionSec (number, 0.8-5, default 2): seconds between the enemy commander's decisions. Higher is easier: a slower, less responsive enemy. Applies at its next decision.
- aiAssaultMult (number, 0.6-2, default 1): how big an army the enemy masses before an all-in attack. Higher means fewer, later, larger attacks and more time to build (easier, calmer); lower means earlier, more frequent pressure (harder, more intense).
- playerIncomeMult (number, 0.5-1.6, default 1): the player's income. Higher is easier and more forgiving of mistakes.
- aiDifficulty (integer 0-2, default 1): the NEXT match's commander, 0 Easy, 1 Normal, 2 Hard. Never changes the match in progress.

Given the player's current flow state, skill metrics, and target mood, output parameter values that guide the player toward the target mood:
- For 'relax': aiIncomeMult ~0.7, aiReactionSec ~4, aiAssaultMult ~1.7, playerIncomeMult ~1.3 - a slow, poor enemy that rarely attacks: room to build a base at leisure
- For 'focus': aiIncomeMult ~1.0, aiReactionSec ~2, aiAssaultMult ~1.0, playerIncomeMult ~1.0 - the game as designed: steady pressure that rewards a sound economy and timely defence
- For 'grit': aiIncomeMult ~1.35, aiReactionSec ~1.2, aiAssaultMult ~0.75, playerIncomeMult ~0.85 - an aggressive, well-funded enemy that punishes slow builds and lost fights; push aiDifficulty to 2 for the next match once the player wins at these settings
- For 'joy': aiIncomeMult ~0.9, aiReactionSec ~2.5, aiAssaultMult ~1.2, playerIncomeMult ~1.2 - big armies on both sides and battles the player tends to win
- For 'curiosity': aiIncomeMult ~0.85, aiReactionSec ~3, aiAssaultMult ~1.5, playerIncomeMult ~1.15 - time to climb the tech tree and try new units

Consider the player's current performance: if the player's armyValue stays far below enemyArmyValue for a minute or more, UNIT_LOST and BUILDING_LOST outnumber ENEMY_KILLED, or the player loses Uplinks they held, the match is too hard: raise aiAssaultMult first (buys time), then raise aiReactionSec, then lower aiIncomeMult; raise playerIncomeMult when scrap stays near zero. If the player's scrap piles up unspent (over ~1500 for long) the bottleneck is their build pace, not the enemy: leave the enemy alone. If the player's army dwarfs the enemy's, ENEMY_KILLED runs far ahead of losses and orders per minute fall, the player may be bored: lower aiAssaultMult, then lower aiReactionSec, then raise aiIncomeMult.

Always adjust gradually from the current values: at most 0.15 on aiIncomeMult and playerIncomeMult, 0.75 s on aiReactionSec and 0.25 on aiAssaultMult at a time, and no more than once every 30 s of battle. Change aiDifficulty only after a GAME_END, by one step. In Last Stand (GAME_START mode "survival") there is no enemy commander: only playerIncomeMult has an effect.`;

export const SKILL_ADJUSTMENT_INSTRUCTIONS = `Battle Drones trains planning (economy and build orders, when to expand and when to attack), task-switching (moving between base management and the battle), attention (tracking threats across the map, under fog of war), perceptual speed (reading a battle at a glance), spatial reasoning (positions, ranges, chokepoints and terrain) and action (orders per minute and precise unit control). Read the clock, scrap, army values and orders per minute from the stamp at the top left of each frame, or from gameState.

Per-skill levers (primary first):
- planning: lower playerIncomeMult so scrap must be spent well, and raise aiAssaultMult a little so the player has time to plan and the plan pays off; ease off if scrap stays near zero and losses mount.
- task-switching: lower aiAssaultMult so attacks come earlier and more often, forcing the player to defend while still building.
- attention: lower aiReactionSec so the enemy scouts and raids more often; watch for UNIT_LOST and BUILDING_LOST far from the player's army as a sign it is too much.
- perceptual-speed and action: lower aiReactionSec and raise aiIncomeMult so fights are larger and come faster; hold playerIncomeMult at 1 so the player's own economy isn't the bottleneck.
- spatial: raise aiAssaultMult (fewer, larger set-piece battles) and keep the enemy's income near 1, so positioning and terrain decide fights rather than numbers.

Move one or two parameters per adjustment, by the same small steps as the mood guidance. aiDifficulty changes only the next match.`;

export const EVENT_SKILL_GUIDANCE = `PROPOSAL (for human review). Battle Drones is a real-time strategy match against an AI commander; every game-specific event is from the player's side of the battle. Read them as follows:
- planning: UNIT_PRODUCED and BUILDING_COMPLETE (with cost) show the build order. Steady production with no long gaps while scrap is available, a Fab Plant or Airpad up early, and harvesters and UPLINK_CAPTURED early (economy first) indicate stronger planning. Scrap piling up unspent in gameState, or a run of UNIT_LOST without new UNIT_PRODUCED, indicates weaker planning.
- task-switching: ORDER events interleaved with UNIT_PRODUCED and BUILDING_COMPLETE within the same 10-20 s, especially while ENEMY_KILLED or UNIT_LOST are happening, show the player managing base and battle at once. Long stretches of only one kind indicate weaker switching.
- attention: UNIT_LOST and BUILDING_LOST with no ORDER in the 10 s before them suggest a threat went unnoticed. UPLINK_LOST soon after UPLINK_CAPTURED, and ENEMY_CALLDOWN followed by several UNIT_LOST (the player didn't move out of a telegraphed strike), also indicate lapses.
- perceptual-speed and action: the rate of ORDER events (gameState apm), and ORDER events with small units counts (individual control) during fights, indicate faster, more precise control. CALLDOWN events that are followed by ENEMY_KILLED within ~5 s show a well-aimed strike.
- spatial: a high ENEMY_KILLED value relative to UNIT_LOST value (killValue vs lossValue in GAME_END and gameState) in a fight the armies entered at similar armyValue indicates good positioning. CRATE_CLAIMED and UPLINK_CAPTURED show the player reading the map for objectives.
Weigh events against the match's difficulty (GAME_START difficulty, and any adjustments): losing to a Hard commander is weaker evidence of low skill than losing to an Easy one.`;
