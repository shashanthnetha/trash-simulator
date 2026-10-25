// Trash Simulator – game engine: composition, loop, interaction
import * as THREE from "three";
import { HorizonTraffic } from "./ambient-ships";
import { Birds } from "./birds";
import { type CollectiblePick, Collectibles } from "./collectibles";
import { Companions } from "./companions";
import { DEV } from "./dev";
import { clearGroundOverrides } from "./ground";
import { type GameAction, InputManager, detectTouch } from "./input";
import { Jeep } from "./jeep";
import { Landmarks } from "./landmarks";
import { mulberry32 } from "./noise";
import type { LighthouseInteraction } from "./place-lighthouse";
import { Places } from "./places";
import { Player } from "./player";
import { PostFX } from "./postfx";
import { ShadowFit } from "./postfx-shadow";
import { Environment } from "./sky";
import { sound } from "./sound";
import { useGame } from "./state";
import { STATION_POS, Station } from "./station";
import { sectorAt, shoreZ, terrainHeight, waveReach } from "./terrain";
import { Detector, type DetectorInteraction } from "./tools-detector";
import { type PickResult, TrashField } from "./trash";
import {
  CATEGORIES,
  type QualityId,
  type Settings,
  TRASH_BY_ID,
} from "./types";
import { DuneBirds } from "./wildlife-birds";
import { Fox } from "./wildlife-fox";
import { World } from "./world";

const SHADOW_SIZE: Record<QualityId, number> = {
  ultra: 4096,
  high: 2048,
  medium: 1536,
  low: 1024,
};

let current: Game | null = null;
export function getGame(): Game | null {
  return current;
}

export class Game {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  // Assigned by the staged boot(); nothing reads them before `booted`.
  private world!: World;
  private env!: Environment;
  private trash!: TrashField;
  private player!: Player;
  private jeep!: Jeep;
  private companions!: Companions;
  private station!: Station;
  private birds!: Birds;
  private landmarks!: Landmarks;
  private places: Places;
  private fox!: Fox;
  private duneBirds!: DuneBirds;
  private collectibles!: Collectibles;
  private ships!: HorizonTraffic;
  private detector!: Detector;
  private postfx: PostFX | null = null;
  private shadowFit: ShadowFit;
  private input!: InputManager;
  private booted = false;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  /** Screen centre (crosshair) – constant, so nothing is allocated per frame. */
  private readonly screenCenter = new THREE.Vector2(0, 0);

  private currentPick: PickResult | null = null;
  private currentFind: CollectiblePick | null = null;
  private lightAct: LighthouseInteraction | null = null;
  private detAct: DetectorInteraction | null = null;
  private pendingType = "";
  private washTimer = 70;
  private envTimer = 0;
  private saveTimer = 0;
  private lastBucketCount = -1;
  private lastJeepCount = -1;
  private lastUpgrades: unknown = null;
  private lastSettings: Settings | null = null;
  private unsub: (() => void) | null = null;
  private disposed = false;
  private readySignaled = false;
  /** Previous frame's running state – drives the pause-audio edge. */
  private wasRunning = true;
  private tmpV = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    current = this;
    this.canvas = canvas;
    const st = useGame.getState();
    const q = st.settings.quality;

    useGame.getState().setIsTouch(detectTouch());

    // Anti-aliasing is normally handled by the MSAA render target of the
    // post-processing chain (postfx.ts); an additionally multisampled canvas
    // would be duplicate work. On "low" there is no post-processing though
    // – there the canvas has to smooth things itself, or everything aliases.
    const canvasAA = q === "low";
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: canvasAA,
        powerPreference: "high-performance",
      });
    } catch {
      // Fallback: some systems refuse the high-performance context
      renderer = new THREE.WebGLRenderer({ canvas, antialias: canvasAA });
    }
    this.renderer = renderer;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = st.settings.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Sum the counters (draw calls, triangles) across all passes of a frame –
    // renderFrame() resets them, not every single render() call.
    this.renderer.info.autoReset = false;
    this.shadowFit = new ShadowFit(q);

    this.places = new Places(this.scene);

    // The world build is seconds of synchronous work (procedural textures
    // above all). It runs in stages that yield to the browser, so the loading
    // screen keeps painting and can name what is being built.
    void this.boot(q).catch((e: unknown) => {
      if (this.disposed) return; // unmounted mid-boot: nothing to report
      const msg =
        e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
      useGame.getState().setEngineStatus("error", msg);
    });
  }

  /** Thrown by boot steps once dispose() has run – ends the staged build. */
  private static readonly ABORT = new Error("boot aborted");

  private async boot(q: QualityId): Promise<void> {
    const canvas = this.canvas;
    const step = async (label: string): Promise<void> => {
      if (this.disposed) throw Game.ABORT;
      useGame.getState().setBootStep(label);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      if (this.disposed) throw Game.ABORT;
    };
    const st = useGame.getState();

    await step("the coast");
    const rng = mulberry32(st.seed ^ 0x5eed);
    this.world = new World(this.scene, q);
    this.env = new Environment(
      this.scene,
      rng,
      (az: number, distM: number) => sound.thunderStrike(az, distM),
      q,
    );
    const sz = SHADOW_SIZE[q];
    this.env.sun.shadow.mapSize.set(sz, sz);

    // The places register walkable surfaces (tip skin, pier deck...) that the
    // trash field places items onto – so they must exist first.
    await this.places.build(q, step);

    await step("the trash");
    const savedRemaining =
      Object.keys(st.remaining).length > 0 ? st.remaining : null;
    this.trash = new TrashField(this.scene, st.seed, savedRemaining);
    useGame.getState().registerWorld(this.trash.initialCountsByKey());

    await step("the station");
    this.player = new Player(
      this.scene,
      this.world,
      st.settings.fov,
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
    );
    this.postfx = PostFX.create(
      this.renderer,
      this.scene,
      this.player.camera,
      q,
    );
    this.jeep = new Jeep(this.scene, STATION_POS.x - 20, STATION_POS.z - 12);
    this.station = new Station(this.scene);

    await step("the wreck and the camp");
    this.landmarks = new Landmarks(this.scene, q);

    await step("the wildlife");
    this.companions = new Companions(this.scene, this.trash);
    this.birds = new Birds(this.scene, q);
    this.fox = new Fox(this.scene, q);
    this.duneBirds = new DuneBirds(this.scene, q);
    this.collectibles = new Collectibles(
      this.scene,
      st.seed,
      (id) => useGame.getState().collection[id] != null,
    );
    this.ships = new HorizonTraffic(this.scene, q);
    this.detector = new Detector(this.scene, q);

    await step("the light");
    this.input = new InputManager(canvas, {
      onLook: (dx, dy) => this.player.addLook(dx, dy),
      onAction: (a) => this.handleAction(a),
      onLockChange: (locked) => this.handleLockChange(locked),
    });
    this.player.refreshBucketFill();
    this.jeep.refreshCargo();
    this.applySettings(useGame.getState().settings, true);
    this.unsub = useGame.subscribe(() => this.onStoreChange());
    window.addEventListener("resize", this.onResize);
    this.onResize();
    if (DEV.enabled) this.applyDev();
    this.env.update(0, this.player.camera.position);
    // Link every program now, while the loading screen is up – otherwise the
    // first frame stalls for the whole batch of shader compiles. The
    // synchronous compile() is used on purpose: compileAsync() polls
    // `currentProgram.isReady()` and never settles when a scene material
    // (hidden instanced meshes) has no program yet.
    try {
      this.renderer.compile(this.scene, this.player.camera);
    } catch {
      // A failed precompile only costs the first-frame stall it was avoiding
    }
    if (this.disposed) throw Game.ABORT;

    this.booted = true;
    this.renderer.setAnimationLoop(() => this.tick());
  }

  // ---------------- Dev harness ----------------
  private applyDev(): void {
    if (DEV.tod !== undefined)
      this.env.timeOfDay = Math.max(0, Math.min(24, DEV.tod));
    if (DEV.weather) this.env.setWeather(DEV.weather, true);
    this.env.freezeTime = DEV.freeze;
    if (DEV.pos) this.player.teleport(DEV.pos[0], DEV.pos[1], DEV.yaw);
    else if (DEV.yaw !== undefined) this.player.yaw = DEV.yaw;
    if (DEV.pitch !== undefined) this.player.pitch = DEV.pitch;
    if (DEV.inJeep) {
      this.jeep.occupied = true;
      this.player.active = false;
      this.player.yaw = this.jeep.heading + (DEV.yaw ?? 0);
      this.player.pitch = DEV.pitch ?? -0.08;
    }
    // Bring light/sky to the requested settings before the very first frame
    this.env.update(0, this.player.position);
    (window as unknown as { __trash?: unknown }).__trash = {
      game: this,
      store: useGame,
      sound,
    };
  }

  /** Dev harness only: access to the subsystems for screenshots and checks. */
  devHandle() {
    return {
      env: this.env,
      player: this.player,
      jeep: this.jeep,
      world: this.world,
      trash: this.trash,
      birds: this.birds,
      companions: this.companions,
      station: this.station,
      landmarks: this.landmarks,
      places: this.places,
      fox: this.fox,
      duneBirds: this.duneBirds,
      collectibles: this.collectibles,
      renderer: this.renderer,
      scene: this.scene,
      postfx: this.postfx,
      shadowFit: this.shadowFit,
      /** Render one frame synchronously (measurements without a VSync cap). */
      renderFrame: () => this.renderFrame(),
    };
  }

  // ---------------- Store sync ----------------
  private onStoreChange(): void {
    const st = useGame.getState();
    if (
      st.bucketCount !== this.lastBucketCount ||
      st.upgrades !== this.lastUpgrades
    ) {
      this.lastBucketCount = st.bucketCount;
      this.player.refreshBucketFill();
    }
    if (
      st.jeepCount !== this.lastJeepCount ||
      st.upgrades !== this.lastUpgrades
    ) {
      this.lastJeepCount = st.jeepCount;
      this.jeep.refreshCargo();
    }
    this.lastUpgrades = st.upgrades;
    if (st.settings !== this.lastSettings)
      this.applySettings(st.settings, false);
  }

  private applySettings(s: Settings, initial: boolean): void {
    this.lastSettings = s;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr * s.renderScale);
    this.postfx?.setPixelRatio(dpr * s.renderScale);
    this.renderer.shadowMap.enabled = s.shadows;
    this.env.sun.castShadow = s.shadows;
    this.player.setFov(s.fov);
    sound.setVolumes(s.volMaster, s.volAmbience, s.volSfx);
    if (!initial) {
      // Materials have to be recompiled when shadows are toggled
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as
          | THREE.Material
          | THREE.Material[]
          | undefined;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
  }

  // ---------------- Actions ----------------
  private handleAction(a: GameAction): void {
    sound.resume();
    const st = useGame.getState();
    if (st.screen !== "game") return;

    // Closing always goes through resume(): setMenu(true) also sets paused, and
    // setMenu(false) deliberately leaves it alone – so clearing only menuOpen
    // would drop the player into the pause panel instead of back into the game.
    if (a === "pause") {
      if (st.menuOpen || st.paused) this.resume();
      else {
        st.setPaused(true);
        this.input.releaseLock();
      }
      return;
    }
    if (a === "menu") {
      if (st.menuOpen) {
        this.resume();
      } else {
        st.setMenu(true);
        this.input.releaseLock();
      }
      return;
    }
    if (a === "inventory" || a === "market") {
      // Direct hotkeys (I / M): open the menu on that tab; pressing the same
      // key again closes back into the game, from another tab it just switches.
      const tab =
        a === "inventory" ? ("inventory" as const) : ("market" as const);
      if (st.menuOpen && st.menuTab === tab) {
        this.resume();
      } else {
        st.setMenu(true, tab);
        this.input.releaseLock();
      }
      return;
    }
    if (st.paused || st.menuOpen) return;

    switch (a) {
      case "primary":
        this.tryGrab();
        break;
      case "jump":
        if (!st.inJeep) this.player.queueJump();
        break;
      case "vehicle":
        this.toggleJeep();
        break;
      case "action":
        this.doAction();
        break;
      case "tool1":
        this.selectTool("picker");
        break;
      case "tool2":
        this.selectTool("detector");
        break;
      case "toolCycle":
        this.selectTool(st.tool === "detector" ? "picker" : "detector");
        break;
      default:
        break;
    }
  }

  /** Equip a hand tool (1/2 keys, mouse wheel, touch Tool button). */
  private selectTool(t: "picker" | "detector"): void {
    const st = useGame.getState();
    if (st.inJeep || st.tool === t) return;
    if (t === "detector" && (st.upgrades.detector ?? 0) < 1) {
      st.toast("No detector yet – the marketplace sells one.", "info");
      return;
    }
    st.setTool(t);
    sound.toolSwap();
  }

  private tryGrab(): void {
    const st = useGame.getState();
    if (st.inJeep || this.player.isGrabbing) return;
    const pick = this.currentPick;
    if (!pick) {
      // Rare finds go straight into the display case – no bucket space needed.
      if (this.currentFind) this.tryCollect(this.currentFind);
      return;
    }
    if (st.bucketCount >= st.bucketCapacity()) {
      sound.bucketFull();
      st.toast("Your bucket is full! Empty it into the jeep (F).", "warn");
      return;
    }
    const ti = pick.typeIdx;
    const id = pick.instanceId;
    const target = this.trash.getInstanceWorld(ti, id);
    this.player.startGrab(
      target,
      () => this.trash.makeGhost(ti),
      () => {
        const s2 = useGame.getState();
        if (s2.bucketCount >= s2.bucketCapacity()) return false;
        const res = this.trash.remove(ti, id);
        if (!res) return false;
        s2.decRemaining(res.key);
        this.pendingType = res.typeId;
        return true;
      },
      () => {
        const def = TRASH_BY_ID[this.pendingType];
        const ok = useGame.getState().pickup(this.pendingType);
        if (ok && def) {
          sound.pickupSound(def.category);
          useGame
            .getState()
            .float(`+10 XP · ${def.name}`, CATEGORIES[def.category].color);
        }
      },
    );
  }

  private tryCollect(pick: CollectiblePick): void {
    const { id, slot } = pick;
    this.player.startGrab(
      pick.point,
      () => this.collectibles.makeGhost(id),
      () => this.collectibles.collect(slot),
      () => {
        if (useGame.getState().foundCollectible(id)) sound.collectibleFound();
      },
    );
  }

  private toggleJeep(): void {
    const st = useGame.getState();
    if (st.inJeep) {
      this.jeep.occupied = false;
      this.player.active = true;
      // drop the player off beside the jeep
      this.tmpV
        .set(1.8, 0, 0)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.jeep.heading);
      this.player.teleport(
        this.jeep.group.position.x + this.tmpV.x,
        this.jeep.group.position.z + this.tmpV.z,
        this.jeep.heading,
      );
      sound.carDoor();
    } else if (this.jeep.canEnter(this.player.position)) {
      this.jeep.occupied = true;
      this.player.active = false;
      this.player.pitch = Math.max(-0.4, Math.min(0.3, this.player.pitch));
      sound.carDoor();
    }
  }

  private doAction(): void {
    const st = useGame.getState();
    // The lighthouse offers its interactions (key, door, breaker) far from
    // the station and jeep drop zones, so it takes priority when in range.
    if (!st.inJeep && this.lightAct) {
      this.lightAct.run();
      return;
    }
    if (!st.inJeep && this.detAct) {
      this.detAct.run();
      return;
    }
    const nearStation = this.station.canInteract(
      st.inJeep ? this.jeep.group.position : this.player.position,
    );
    if (nearStation && (st.bucketCount > 0 || st.jeepCount > 0)) {
      // Use the deposit's own points figure – diffing recyclePoints around the
      // call would fold concurrent mission bonuses into the toast.
      const dep = this.station.deposit();
      if (dep.count > 0) {
        st.toast(
          `${dep.count} items dropped off · +${dep.points} points`,
          "good",
        );
      } else {
        st.toast("The station is full – wait for it to process.", "warn");
      }
      return;
    }
    if (!st.inJeep && this.jeep.canEnter(this.player.position)) {
      if (st.bucketCount === 0) {
        st.toast("Your bucket is empty.", "info");
        return;
      }
      const catsBefore = new Set(
        Object.keys(st.bucket)
          .filter((k) => st.bucket[k] > 0)
          .map((k) => TRASH_BY_ID[k]?.category)
          .filter((c): c is NonNullable<typeof c> => c != null),
      );
      const n = st.transferBucketToJeep();
      if (n > 0) {
        sound.dumpCascade([...catsBefore]);
        st.toast(`${n} items loaded into the jeep`, "good");
      } else {
        st.toast("The flatbed is full!", "warn");
      }
    }
  }

  private handleLockChange(locked: boolean): void {
    const st = useGame.getState();
    if (
      !locked &&
      st.screen === "game" &&
      !st.menuOpen &&
      !st.paused &&
      !st.isTouch
    ) {
      st.setPaused(true);
    }
  }

  resume(): void {
    const st = useGame.getState();
    st.setPaused(false);
    st.setMenu(false);
    this.input.requestLock();
  }

  // ---------------- Loop ----------------
  private tick(): void {
    if (this.disposed || !this.booted) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const st = useGame.getState();
    const running = !st.paused && !st.menuOpen && st.screen === "game";

    if (running) {
      const mv = this.input.getMove();
      if (st.inJeep) {
        this.jeep.input.f = mv.f;
        this.jeep.input.r = mv.r;
        this.jeep.input.brake = mv.sprint;
        this.player.move.f = 0;
        this.player.move.r = 0;
        this.player.move.sprint = false;
        this.jeep.driverEye(this.player.position);
      } else {
        this.player.move = mv;
        this.jeep.input.f = 0;
        this.jeep.input.r = 0;
        this.jeep.input.brake = false;
      }

      this.player.update(dt);
      this.jeep.update(dt, this.env);
      this.station.update(dt, this.env);
      this.companions.update(
        dt,
        this.player.active ? this.player.position : this.jeep.group.position,
        this.jeep.group.position,
        this.env,
        this.player.camera,
      );
      const cam = this.player.camera.position;
      this.env.update(dt, cam);
      this.world.update(dt, this.env, cam);
      this.birds.update(dt, this.env, this.player.camera);
      this.landmarks.update(dt, this.env, cam);
      this.places.update(dt, this.env, cam);
      const focus = this.player.active
        ? this.player.position
        : this.jeep.group.position;
      this.fox.update(dt, focus, this.env);
      this.duneBirds.update(dt, focus, this.env, this.player.camera);
      this.collectibles.update(dt, focus);
      this.ships.update(dt, this.env, cam);
      this.detector.update(
        dt,
        this.env,
        this.player.camera,
        st.tool === "detector" && !st.inJeep && this.player.active,
      );

      this.updateInteraction();
      this.updateAmbience(dt);
      this.updateTimers(dt);
    }

    // Horn is a held action (H key / touch button), so it is polled per frame
    // rather than fired through the one-shot GameAction path.
    sound.setHorn(running && st.inJeep && this.input.hornHeld());

    // Pause edge: duck the whole mix and silence the stateful loops (engine,
    // drone rotor) – otherwise a full-throttle engine keeps droning behind the
    // pause panel, because updateEngine/droneSound only run while `running`.
    if (running !== this.wasRunning) {
      this.wasRunning = running;
      sound.setPaused(!running);
      if (!running) {
        sound.updateEngine(false, 0);
        sound.droneSound(false, 0, 1, 0);
      }
    }

    this.renderFrame();
    if (!this.readySignaled) {
      this.readySignaled = true;
      st.setEngineStatus("ready");
    }
  }

  /** One frame: fit the shadow box, then run the chain or render directly. */
  private renderFrame(): void {
    this.renderer.info.reset();
    if (this.renderer.shadowMap.enabled)
      this.shadowFit.apply(this.env.sun, this.player.camera);
    if (this.postfx?.enabled) this.postfx.render(this.env);
    else this.renderer.render(this.scene, this.player.camera);
  }

  private updateInteraction(): void {
    const st = useGame.getState();
    let prompt = "";
    let grab = false;

    if (!st.inJeep && !this.player.isGrabbing) {
      this.raycaster.setFromCamera(this.screenCenter, this.player.camera);
      const pick = this.trash.raycastPick(
        this.raycaster,
        this.player.grabRange(),
      );
      this.currentPick = pick;
      this.trash.setHighlight(pick);
      if (pick) {
        const cat = CATEGORIES[pick.def.category].name;
        grab = true;
        prompt = st.isTouch
          ? `${pick.def.name} (${cat}) – Tap Grab`
          : `${pick.def.name} (${cat}) – Click to pick up`;
      }
      // Rare finds: only offered while no piece of trash is in the crosshair.
      const find = pick
        ? null
        : this.collectibles.raycastPick(
            this.raycaster,
            this.player.grabRange(),
          );
      this.currentFind = find;
      this.collectibles.setHighlight(find);
      if (find) {
        grab = true;
        prompt = st.isTouch
          ? `Rare find: ${find.name} – Tap Grab`
          : `Rare find: ${find.name} – Click to pick up`;
      }
    } else {
      this.currentPick = null;
      this.currentFind = null;
      this.trash.setHighlight(null);
      this.collectibles.setHighlight(null);
    }

    const nearJeep = !st.inJeep && this.jeep.canEnter(this.player.position);
    const nearStation = this.station.canInteract(
      st.inJeep ? this.jeep.group.position : this.player.position,
    );
    this.lightAct = st.inJeep
      ? null
      : (this.places.lighthouse?.interaction(
          this.player.position,
          this.player.camera,
        ) ?? null);
    this.detAct =
      st.inJeep || this.lightAct !== null
        ? null
        : this.detector.interaction(this.player.position, this.player.camera);
    // Touch shows the button captions (Use/Exit/Enter), PC the key names.
    const key = (pc: string, touch: string) => (st.isTouch ? touch : pc);
    const extra: string[] = [];
    if (this.lightAct)
      extra.push(
        key(`F: ${this.lightAct.prompt}`, `Use: ${this.lightAct.prompt}`),
      );
    if (this.detAct)
      extra.push(key(`F: ${this.detAct.prompt}`, `Use: ${this.detAct.prompt}`));
    if (nearStation && (st.bucketCount > 0 || st.jeepCount > 0))
      extra.push(
        key("F: Drop off at the station", "Use: drop off at the station"),
      );
    if (st.inJeep) extra.push(key("E: Get out", "Exit: get out"));
    else if (nearJeep) {
      extra.push(key("E: Get in the jeep", "Enter: get in the jeep"));
      if (st.bucketCount > 0 && !nearStation)
        extra.push(key("F: Empty bucket into the jeep", "Use: empty bucket"));
    }
    if (extra.length > 0)
      prompt =
        prompt !== ""
          ? `${prompt}\n${extra.join("  ·  ")}`
          : extra.join("  ·  ");
    st.setPrompt(prompt, grab);
  }

  private updateAmbience(dt: number): void {
    const st = useGame.getState();
    const p = this.player.camera.position;
    const shoreDist = Math.abs(p.z - shoreZ(p.x));
    sound.updateAmbience(
      dt,
      shoreDist,
      this.env.wind,
      this.env.rain,
      this.env.isDay,
      this.env.weather === "storm",
      {
        cloud: this.env.cloud,
        timeOfDay: this.env.timeOfDay,
        inJeep: st.inJeep,
        jeepSpeed01: st.jeepSpeed / Math.max(1, this.jeep.maxSpeed()),
        camHeight: p.y - terrainHeight(p.x, p.z),
        waveReach: waveReach(this.env.envTime),
        lightning: this.env.lightningFlash,
        yaw: this.player.yaw,
        altitude: p.y,
      },
    );
  }

  private updateTimers(dt: number): void {
    const st = useGame.getState();

    this.envTimer += dt;
    if (this.envTimer >= 1) {
      this.envTimer -= 1;
      st.addPlaySeconds(1);
      st.setEnv({
        timeOfDay: this.env.timeOfDay,
        weather: this.env.weather,
        weatherName: this.env.weatherName(),
        sectorName: sectorAt(this.player.camera.position.x).name,
      });
      st.addDistance(this.player.distanceMoved, 0);
      this.player.distanceMoved = 0;
    }

    if (st.settings.washUp) {
      this.washTimer -= dt;
      if (this.washTimer <= 0) {
        this.washTimer = 60 + Math.random() * 60;
        const keys = this.trash.washUp(3 + Math.floor(Math.random() * 5));
        const counts: Record<string, number> = {};
        for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
        for (const k of Object.keys(counts)) st.incRemaining(k, counts[k]);
        if (keys.length > 0) {
          sound.washUp();
          st.toast("The tide has washed up new trash!", "info");
        }
      }
    }

    this.saveTimer += dt;
    if (this.saveTimer >= 25) {
      this.saveTimer = 0;
      st.markDirty();
    }
  }

  private onResize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.postfx?.setSize(w, h);
    this.player.camera.aspect = w / Math.max(1, h);
    this.player.camera.updateProjectionMatrix();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (current === this) current = null;
    this.renderer.setAnimationLoop(null);
    // A dispose during the staged boot finds only part of this built – the
    // pending boot step throws ABORT on its next check.
    this.unsub?.();
    window.removeEventListener("resize", this.onResize);
    this.input?.dispose();
    this.companions?.dispose();
    this.station?.dispose();
    this.jeep?.dispose();
    this.player?.dispose();
    this.birds?.dispose();
    this.landmarks?.dispose();
    this.places.dispose();
    clearGroundOverrides();
    this.fox?.dispose();
    this.duneBirds?.dispose();
    this.collectibles?.dispose();
    this.ships?.dispose();
    this.detector?.dispose();
    this.trash?.dispose();
    this.world?.dispose();
    this.env?.dispose();
    sound.updateEngine(false, 0);
    useGame.getState().markDirty();
    this.postfx?.dispose();
    this.postfx = null;
    // Leave the unpack state clean. A canvas keeps ONE WebGL context, so a
    // renderer built on this canvas later inherits it – and three.js uploads
    // two placeholder 3D textures while building its WebGLState, which WebGL
    // rejects while FLIP_Y/PREMULTIPLY_ALPHA is set ("texImage3D: FLIP_Y or
    // PREMULTIPLY_ALPHA isn't allowed for uploading 3D textures", twice).
    const gl = this.renderer.getContext();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.renderer.dispose();
  }
}
