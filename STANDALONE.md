# Trash Simulator - standalone web build

This branch adapts the original caffeine.ai/ICP game (see `main` branch, preserved untouched) into a free static web app.

## Changes vs original
- Backend (Motoko/Internet Computer) removed from the runtime path; the same save/load logic now runs on browser localStorage (`useBackendSync.ts`), keeping the original exported interface.
- Internet Identity sign-in removed (`main.tsx`) - the game opens straight to the menu.
- Market and Leaderboard tabs removed (`components/Menus.tsx`) plus the market hotkey (M) in `game/engine.ts` and `game/input.ts` - both depended on the ICP backend and token economy.
- Copy tweaks on the start/pause screens to describe local saves.
- `vite.config.js` uses relative asset paths (`base: "./"`) so it can be hosted from any static path (e.g. GitHub Pages).

## Play
Open the deployed page, enter a callsign, play. Progress (profile + save) lives in your browser only; clearing site data resets it.
