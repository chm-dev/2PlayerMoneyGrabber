## Money Grabber (Rubasoldi) - web port of Android mini-game from [JungleFrog.TwoPlayers.Rubasoldi](https://play.google.com/store/apps/details?id=com.JindoBlu.TwoPlayerGamesChallenge&hl=en)

Original APK reverse engineered using [REA](https://rea.tools) + Ghidra and rebuilt for web by DeepSeek V4.1 Flash.

The original is a flat 2D scene in portrait. Money spawns in the middle and you drag it into your vault: red at the bottom, blue at the top. There is no gravity — an item glides toward the average of every touch that is on it, at a speed that depends on the item.

* Spawning: one item per second while fewer than 4 are in play, somewhere in the ±2.93 band around the middle and ±3 vertically, and 20 % of them are banknotes. A new item stays inactive for 1 s, then pops in with a sparkle burst.
* Dragging: the item eases toward the centre of your touches (coin speed 4, banknote speed 1, ×1.5 while held), tilts toward the drag direction, and keeps drifting in that direction when you let go. Each item accepts at most 2 fingers.
* Hooks: every touch gets its own string that ends in a cat paw. The paw holds the item, the line runs to your finger, and it is blue when the paw is below the finger and red when it is above.
* Scoring: coin = 1 point, banknote = 3. The vault punches when it takes money and the item is sucked in, shrinks and fades. A match is first to 15.
* CPU: after a random reaction delay (1.2-2.5 s Easy, 0.7-1.5 s Medium, 0.45-1.1 s Hard) the CPU hooks a new item, as long as it has fewer than 3/5/5 hooks in flight. Its hook is anchored to a virtual finger at the top of the screen, so it always drags money up into the blue vault, and it is never released: a hooked coin can no longer be scored red, you can only stall it or let it score blue.
* Tearing a banknote: two fingers stretch it (the sprite stretches along the drag axis and springs back), but per the shipped maths it can only actually rip while the CPU's hook is on it, and nobody scores a torn banknote. See the notes below.
* Assets: sprites and sounds are extracted from the game: coin, banknote and its two torn halves, vault, cat paw, circles, plus the `soldi` and `strappo` clips.
* Run it from any static server, e.g. `python -m http.server 8765 --bind 127.0.0.1` in the repo root, then open `http://127.0.0.1:8765/web/rubasoldi/`.

### Remaining guesses and gaps:

* Tear threshold: the shipped code stretches the banknote mesh and then springs the whole mesh scale back toward 1 every frame at the same rate, so two fingers settle at about 1.49 while the tear needs 1.7 — measured, not guessed, but it means a two-finger tear never fires. The port reproduces that. If it ever turns out the original intends a real two-finger tear, the fix is to skip the spring-back while the item is being stretched.
* Tween curves: the shared JindoTween prefab was never extracted, so the collect move uses a smoothstep, the fade is linear, and the vault punch is a short sine bump.
* Touch offsets: `offsetToccoInizialeWorld/Screen` are treated as 0, so the paw sits at the item's centre instead of exactly where you grabbed it.
* Particles: burst size, speed, lifetime and direction come from the serialized particle system, but the particle texture and its lifetime look are approximations.
* Scoreboard and win screen: simple side badges and a plain overlay, since the shared in-game UI prefab was never extracted.
* Hook drawing order follows the prefab sorting orders (line 75, finger dots 80/85, paw 100) rather than any runtime logic; the inactive `Base` circles under the play area are not drawn.
