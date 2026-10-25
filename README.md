# Trash Simulator

A stretch of coastline, thousands of finds, eight recycling categories: pick it
up, sort it right, drop it off at the station — with a jeep, a dog and a drone,
under dynamic weather, a full day/night cycle and procedural sound. Built as a
**caffeine.ai project** for the **Internet Computer** (Motoko backend +
React/Three.js frontend).

## Sign-in and saving

The game is playable only when signed in with **Internet Identity**. On your
first login you choose a display name; it is unique across the project and
assigned once. All progress lives in your profile on chain — there is no local
save. The game saves automatically every five minutes, and manually via
"Save to profile now" in the pause menu, when returning to the main menu, and
when the tab is closed.

## Importing into caffeine.ai

1. Create a new project on [caffeine.ai](https://caffeine.ai) or open the
   import dialog.
2. Upload this ZIP file (the archive holds the complete project with
   `caffeine.toml` at its root).
3. During the build Caffeine generates the actor bindings automatically
   (`src/frontend/src/backend.ts` is replaced by the generated version) and
   deploys backend and frontend.

### Alternative: locally with the Caffeine CLI

```bash
pnpm install          # dependencies
caffeine check --fix  # check/format Motoko
caffeine build        # build backend + frontend, generate bindings
caffeine preview      # run locally
```

Useful frontend scripts: `pnpm typecheck`, `pnpm check` / `pnpm fix` (Biome),
`pnpm build` (Vite).

## Controls

| Action | PC | Touch |
| --- | --- | --- |
| Walk | **WASD** / arrow keys | left stick |
| Look around | mouse | swipe the right half of the screen |
| Grab trash | **left click** | Grab |
| Sprint / jeep brake | **Shift** | Sprint |
| Jump | **Space** | ⤴ button |
| Enter/leave the jeep | **E** | Enter |
| Empty bucket / drop off | **F** | Unload |
| Horn (hold, in the jeep) | **H** | Horn |
| Menu (upgrades, missions …) | **Tab** | Menu |
| Inventory | **I** | Menu → Inventory |
| Marketplace | **M** | Menu → Market |
| Pause & settings | **Esc** | Pause |

## How it plays

- **Collect:** aim at a piece of trash (white outline) and grab — the picker
  closes on it and the object visibly lands in your bucket (+10 XP).
- **Transfer:** empty a full bucket onto the jeep's load bed with **F**.
- **Dispose:** drive to the recycling station and hand it over with **F**
  (+10 XP per item plus recycling points by category).
- **Recycle & trade:** the station bales what you hand in into eight real
  commodities at fixed rates (e.g. 10 plastic items → 1 kg PET flakes, 8 glass
  → 1 kg glass cullet, 6 metal → 1 kg metal scrap …). Sell them to the
  wholesaler at base prices or list them on the **open marketplace** and trade
  with other collectors — the wallet is in dollars, kept on chain.
- **Upgrade:** invest recycling points in 12 upgrades — among them a bigger
  bucket, a longer picker, a faster jeep, a **dog** (collects for you) and a
  **drone** (flies trash straight to the jeep).
- **Missions:** 12 assignments with XP and point rewards, level system up to
  level 250.
- **Keep track:** the Tab menu holds the upgrade board, missions, a full
  inventory (bucket, jeep, depot queue and materials store), the marketplace,
  the display case, statistics and the leaderboard.
- **Rare finds:** now and then a fossil, an old coin, a message in a bottle or
  a piece of jewellery lies half-buried somewhere along the coast — watch for
  a faint sparkle. Every piece exists exactly once; the **Collection** tab
  shows your display case with a rotatable 3D view of each find and lets you
  read the bottle letters.
- **Explore:** the coast has places worth the walk — the stranded fishing
  boat, an abandoned camp, a tipped shipping container, the ruined pier, a
  chapel being swallowed by the dunes, an old landfill, a telegraph cable
  house, a collapsed dune front with a fallen pillbox, a bothy in the pines,
  the sunken lane to the field gate and the wardens' boardwalk.
- **Relight the coast:** the Saltreach Light stands locked on its knoll behind
  the eastern cape. The keeper's key still hangs in an abandoned building
  somewhere — find it, unlock the tower, climb the spiral stair and throw the
  breaker to set the great lens turning again.

## Features

- Open beach world (beach, foredunes, dune ridges, a pine belt and the
  hinterland behind it) with ~1000 scattered trash objects in 25 types and
  8 categories — every piece a detailed model with procedural PBR textures
  (labels, rust, cardboard, wood, netting …)
- Twelve built places with a story, all procedural and all walkable: the
  clinker fishing boat "Sea Lark" stranded at the waterline, an abandoned
  camp with weathered tents, a tipped 20 ft shipping container with spilled
  cargo, the Old Pier (a walkable ruined deck over the sea), Chantry Knoll (a
  drystone chapel ruin on a gorse hill), the Old Tip (a grassed-over landfill
  bleeding refuse from its flank), the Sealane cable house and its wireless
  pole line, the Bitten Edge (a storm-cut dune scarp with anti-tank cubes and
  an enterable fallen pillbox), Keld Bothy (a roofed interior with a door
  that swings in the wind), Lane's End (a sunken hawthorn lane ending at an
  open field gate and cattle grid), the Wardens' Boardwalk and the Saltreach
  Light — a climbable red-and-white lighthouse with a locked door, a keeper's
  key hidden across the map, a breaker box and a rotating first-order lens
  whose beam reads truly at every hour and in every weather — with their own
  landforms in the analytic terrain, colliders and walkable surfaces
- 24 unique collectibles (fossils, coins, message bottles with letters,
  jewellery) with a display case, 3D inspect viewer and readable letters
- Wildlife: gulls, foraging plover and pipit flocks that flush when
  approached, a rare red fox that crosses the dunes and flees, crickets and
  fireflies at night
- A metal detector and trowel from the marketplace: equip tools with the
  1/2 keys or the mouse wheel, sweep for a buried layer of deep finds along
  the foreshore (Geiger-style blips, pinpoint tone, dig them out for bonus
  points) — dug spots persist in the save
- Passing lights: on some nights a distant vessel crosses the horizon,
  masthead and side lamps twinkling far out to sea; in murky weather a
  foghorn calls out of the grey instead — nothing ever comes ashore
- New vegetation: maritime pines swaying in the wind, gorse, nettles, elder,
  hawthorn and blackthorn hedges, cow parsley, dock and thistle
- Sea with Gerstner swell and wind chop, a breaker line, whitecaps, a run-up
  film whose foam edge matches the wet sand, sun and moon glitter, depth-based
  colour and rain rings
- Sky with atmospheric scattering (Rayleigh/Mie), a twilight belt, shader
  clouds, thousands of stars with a Milky Way band, a textured moon with real
  moonlight, rain streaks and lightning; full day/night cycle
- Dynamic weather (clear → storm with lightning and thunder)
- Dune grass with a gust field in the vertex shader, ground cover, rocks (wet
  near the shore), shells; a gull flock with wing beats, thermals, dives and
  positional calls
- Fully procedural sound (surf with individual waves timed to the run-up,
  wind gusts, rain including on the jeep roof, thunder, gulls, an engine with
  gears, grab and disposal sounds, a limiter) — no audio files needed
- Detailed beach jeep (frame, per-wheel suspension, interior with instruments,
  head/brake/reverse lights, cargo with a rope net) with off-road physics
- Bucket and picker in hand as real models: pendulum physics, visible contents,
  gloves, animated jaws and a telescoping shaft
- Post-processing (HDR render target with MSAA, subtle bloom, colour grading,
  vignette) and a camera-fitted shadow box — scaled by quality tier
- Companions with their own AI: a shell-furred dog (gait blending, sparse
  barks that fade with distance and weather) and a physically flown delivery
  drone with a green night beacon
- Material recycling into eight commodities, an on-chain **open marketplace**
  (order book, partial buys, wholesale) and a dollar wallet
- Station yard with real collisions for the player and the jeep; a working
  horn (hold **H**)
- Minimal HUD, tab menu, pause menu with graphics/audio/control options
  (4 quality tiers, render scale, FOV and much more)
- Progress saved to your on-chain profile (**Internet Identity login**)
  including an **online leaderboard** and global statistics
- Runs best on PC, but is fully playable by touch

## Project layout

```
caffeine.toml            project definition (Caffeine)
mops.toml                Motoko packages
src/backend/             Motoko actor (saves, leaderboard, statistics)
src/frontend/            React + Three.js + Tailwind + zustand
  src/game/              engine (engine.ts), terrain maths (terrain.ts) and
                         the places' landforms (landforms.ts), walkable
                         surfaces (ground.ts), colliders (colliders.ts),
                         sky/weather (sky*.ts), sea (ocean*.ts),
                         vegetation incl. pines (vegetation*.ts),
                         birds (birds.ts, wildlife-birds.ts), fox
                         (wildlife-fox.ts), trash (trash*.ts),
                         collectibles (collectibles*.ts), landmarks
                         (landmark-*.ts) and built places (place-*.ts),
                         jeep (jeep*.ts), player/viewmodel (player*.ts),
                         companions (companions*.ts),
                         post-processing (postfx*.ts),
                         textures (textures*.ts), sound (sound*.ts)
  src/components/        HUD, menus, touch UI, start screen
  src/hooks/             cloud sync (Internet Identity + actor)
```

### Development harness

Only in the Vite dev build (`pnpm dev`) and only with `?dev=1` in the URL does
the game start without a login; time of day, weather, position and view can be
set from the URL, for example
`http://127.0.0.1:5173/?dev=1&tod=17.6&weather=storm&pos=0,-34&yaw=0&freeze=1`
(`tod` 0–24, `weather` sunny|partly_cloudy|overcast|rain|storm,
`q` ultra|high|medium|low, `injeep=1` driver view, `seed` world seed). The
harness is disabled in the production build.

Happy cleaning.
