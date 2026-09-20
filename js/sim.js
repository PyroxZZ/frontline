'use strict';
// World state + simulation. Territory is a grid of per-country control values
// (each cell sums to 1). Units push control toward their country around them;
// the renderer draws the frontline where the top two countries are equal, so
// the front moves continuously as control shifts.
(function () {
  const G = window.G = {};

  const WORLD_W = 2400, WORLD_H = 1350, CELL = 10;
  const GW = WORLD_W / CELL, GH = WORLD_H / CELL, N = GW * GH, NC = 4;
  // province lattice: spacing, jitter (fraction of spacing), row height, cols, rows
  const PS = 135, PJ = 0.36, PROW = PS * 0.866, PC = Math.ceil(WORLD_W / PS) + 1, PR = Math.ceil(WORLD_H / PROW);
  Object.assign(G, { WORLD_W, WORLD_H, CELL, GW, GH, N, NC, PS, PJ, PC, PR });

  // atk scales capture pressure + damage dealt, def scales holding pressure +
  // damage resisted, cost is the price of a division (upkeep scales with it).
  G.COUNTRIES = [
    { name: 'France',  trait: 'Fortified', atk: 1.0,  def: 1.3, speed: 0.95, cost: 100, capital: 'Paris',  color: '#4a78d0', cap: [0.24, 0.42], flag: { dir: 'v', stripes: ['#0055A4', '#FFFFFF', '#EF4135'] } },
    { name: 'Germany', trait: 'Elite',     atk: 1.3,  def: 1.1, speed: 1.1,  cost: 140, start: 9, capital: 'Berlin', color: '#767b84', cap: [0.50, 0.31], flag: { dir: 'h', stripes: ['#111111', '#DD0000', '#FFCE00'] } },
    { name: 'Poland',  trait: 'Horde',     atk: 0.85, def: 0.9, speed: 1.0,  cost: 65,  capital: 'Warsaw', color: '#d05a74', cap: [0.77, 0.45], flag: { dir: 'h', stripes: ['#FFFFFF', '#DC143C'] } },
    { name: 'Italy',   trait: 'Swift',     atk: 0.95, def: 0.9, speed: 1.3,  cost: 85,  capital: 'Rome',   color: '#45a366', cap: [0.50, 0.74], flag: { dir: 'v', stripes: ['#009246', '#FFFFFF', '#CE2B37'] } },
  ];

  // Unit types multiply the country's stats. atk = capture pressure, def = holding
  // pressure, dmg = damage dealt, armor = damage taken, cost = x the country's division cost.
  G.UNIT_TYPES = {
    infantry: { name: 'Infantry', key: 'R', cost: 1,   atk: 1,    def: 1,   dmg: 1,   armor: 1,   speed: 1 },
    guard:    { name: 'Guards',   key: 'G', cost: 2.6, atk: 0.55, def: 1.6, dmg: 0.5, armor: 0.4, speed: 0.85 },
  };
  G.unitCost = (k, type) => Math.round(G.COUNTRIES[k].cost * G.UNIT_TYPES[type].cost);

  // Buildings stand on firmly held land and are lost when the ground is.
  // Artillery shells flip a small circle of enemy land next to the front (power =
  // control shifted at the centre) and hurt units caught in it. A barracks is an
  // alternative muster point for new divisions.
  G.BUILDINGS = {
    artillery: { name: 'Artillery', key: 'T', cost: 150, range: 170, reload: 4, blast: 30, power: 0.7, dmg: 0.07 },
    barracks:  { name: 'Barracks',  key: 'B', cost: 120 },
  };

  // Jets are based at the capital. They fly to the country's air marker, circle
  // it for `loiter` seconds rocketing enemy ground next to the border within
  // `range` of the marker, then fly home to rearm. upkeep is in infantry-equivalents.
  G.JET = { name: 'Jet', key: 'J', cost: 320, speed: 170, turn: 2.6, loiter: 22, rearm: 10, range: 130, reload: 1.1, blast: 20, power: 0.5, dmg: 0.04, upkeep: 3 };

  // Supply flows from the capital and from barracks, province to province through
  // land the country firmly holds. Levels: 2 supplied (within `full` provinces of a
  // source), 1 strained (within `strained`), 0 cut off. Arrays below are indexed
  // by level. A barracks severed from the capital is a depot with `depot` seconds
  // of stock. zone = speed by distance (in provinces) from the front: slow in the
  // combat zone, fast in the rear.
  G.SUPPLY = {
    full: 4, strained: 7, depot: 60,
    push: [0.15, 0.6, 1], hold: [0.6, 1, 1], dmg: [0.5, 0.85, 1], speed: [0.5, 0.85, 1],
    attrition: 0.014,            // strength/s lost while cut off (~50s from full to surrender)
    surrenderAt: 0.3, reward: 0.5,   // cut-off units below this give up; captor gets this share of their cost
    zone: [0.3, 0.3, 0.3, 0.6, 1],
  };

  // How a unit behaves, set per unit by the player (the AI uses them too).
  // stance: push = capture pressure x, hold = holding pressure x, hurt = damage taken x, dig = dig-in speed x
  G.STANCES = {
    hold:    { name: 'Hold',    push: 0,    hold: 1.25, hurt: 0.9, dig: 2 },
    probe:   { name: 'Probe',   push: 0.25, hold: 1,    hurt: 1,   dig: 1 },
    attack:  { name: 'Attack',  push: 1,    hold: 1,    hurt: 1,   dig: 1 },
    assault: { name: 'Assault', push: 1.5,  hold: 1,    hurt: 1.5, dig: 0 },   // tires: push falls toward 0.7 over ~40s of fighting
  };
  G.RETREATS = { stand: 'Stand', low: 'Fall back when weak', outnumbered: 'Fall back if outnumbered' };
  G.PURSUITS = { line: 'Hold the line', exploit: 'Exploit' };
  G.FOCUSES = { spread: 'Spread', mass: 'Concentrate' };
  G.BEHAVIOUR = { fallBelow: 0.4, returnAt: 0.7, calm: 6 };
  G.MOVES = { edge: 'Line the edge', straight: 'Straight in' };
  // Guards steady the line: friendly units within `range` of a guard hold harder and take less damage (doesn't stack).
  G.GUARD_AURA = { range: 80, hold: 1.35, hurt: 0.8 };

  // Placeholder gameplay numbers - all of this is expected to change.
  const T = G.TUNE = {
    speed: 46,          // world units / s in friendly territory
    creep: 0.15,        // fraction of speed kept while closing up to the border
    lookahead: 22,
    capR: 9,            // capture radius, in cells
    capRate: 0.2,
    defBonus: 1.5,      // pressure multiplier on ground your country already holds
    pushAhead: 30,      // a moving unit also pushes the province this far ahead of it
    sepFriend: 26,      // minimum spacing between units
    sepMoving: 17,      // ...while one of two friendly units is on the move
    sepEnemy: 34,
    fightRange: 65,
    damage: 0.032,
    regen: 0.015,
    startUnits: 6,
    // economy: income/s = baseIncome + shareIncome * territory share - upkeep * cost per unit
    startMoney: 120, baseIncome: 2, shareIncome: 36, upkeep: 0.004,
    // entrenchment: a unit with no orders digs in over digTime seconds
    digTime: 18, digDef: 0.8, digArmor: 0.4,
    phaseFrom: 2,       // friendly units pass through each other this many provinces back from enemy ground (1 = even in border provinces)
    frontPush: 0.25,    // capture pressure kept by units in hold-the-front mode
    cityIncome: 4,      // money/s for every captured capital you hold (on top of its land)
    occupyTime: 20,     // seconds an enemy must hold a capital before its country capitulates
    pocketFade: 0.45,   // control/s at which an enclosed pocket turns into its surrounder
    stack: 0.25,        // extra capture pressure per additional unit pushing the same province (max x2)
    flank: 0.1,         // extra damage taken per additional enemy in range
    // terrain per province: 0 plains, 1 hills, 2 fortified (capitals)
    terrAtk: [1.25, 0.75, 0.4],     // capture pressure when taking this ground
    terrDef: [1, 1.35, 2],          // pressure when holding it
    terrArmor: [1, 0.8, 0.7],       // damage taken while standing on it (own land only)
    terrSpeed: [1, 0.7, 1],
  };

  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const hyp = (a, b) => Math.sqrt(a * a + b * b);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  G.clamp = clamp; G.lerp = lerp; G.smoothstep = smoothstep;

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function hash2(ix, iy, seed) {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function vnoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return lerp(
      lerp(hash2(ix, iy, seed), hash2(ix + 1, iy, seed), sx),
      lerp(hash2(ix, iy + 1, seed), hash2(ix + 1, iy + 1, seed), sx), sy);
  }

  function fbm(x, y, seed) {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f, seed + i); n += a; a *= 0.5; f *= 2; }
    return s / n;
  }

  // Bilinear sample of a grid array at world coords (matches GPU texel centres).
  function bil(arr, stride, off, x, y) {
    const fx = clamp(x / CELL - 0.5, 0, GW - 1.001), fy = clamp(y / CELL - 0.5, 0, GH - 1.001);
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy;
    const i00 = (iy * GW + ix) * stride + off, i10 = i00 + stride, i01 = i00 + GW * stride, i11 = i01 + stride;
    return (arr[i00] * (1 - tx) + arr[i10] * tx) * (1 - ty) + (arr[i01] * (1 - tx) + arr[i11] * tx) * ty;
  }

  G.terrAt = (x, y) => { const id = G.cellProv[clamp(y / CELL | 0, 0, GH - 1) * GW + clamp(x / CELL | 0, 0, GW - 1)]; return id < 0 ? 0 : G.provTerr[id]; };
  G.landAt = (x, y) => x > 0 && y > 0 && x < WORLD_W && y < WORLD_H && bil(G.land, 1, 0, x, y) > 0.52;
  G.ctlAt = (k, x, y) => bil(G.ctl, NC, k, x, y);

  G.init = function (seed) {
    G.rndState = seed | 0;
    const rnd = G.rnd = function () {   // mulberry32
      let a = G.rndState = G.rndState + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
    G.time = 0;
    G.player = 0;            // UI only: which country this screen controls
    G.aiPassive = false;     // tutorial: the AI neither moves nor buys
    G.net = false;           // true in a network game: then G.humans decides who the AI leaves alone
    G.humans = new Set();
    G.units = [];
    G.effects = [];
    G.clashes = [];
    G.buildings = [];
    G.shells = [];
    G.muster = new Array(NC).fill(null);   // active barracks per country (null = capital)
    G.aiGoal = new Array(NC).fill(null);
    G.jets = [];
    G.airMark = new Array(NC).fill(null);   // {x, y} the country's jets operate around
    G.aiAir = new Float32Array(NC);
    G.dead = new Array(NC).fill(false);
    G.occupy = new Float32Array(NC);        // 0..1 progress of an enemy occupying each capital
    G.annex = [];
    G.events = [];                          // consumed by the UI: { type: 'capitulate', k, to }
    G.winner = -1;
    G.supDist = []; G.supParent = []; G.frontDist = [];
    for (let k = 0; k < NC; k++) { G.supDist.push(new Int16Array(PC * PR).fill(-1)); G.supParent.push(new Int32Array(PC * PR).fill(-1)); G.frontDist.push(new Int16Array(PC * PR).fill(-1)); }
    G.holdT = 0;
    G.autoFront = new Array(NC).fill(false);   // new divisions go straight to the front
    G.nextId = 1;
    G.seed = seed;
    G.money = new Float32Array(NC).fill(T.startMoney);
    G.income = new Float32Array(NC);
    G.statT = 0;
    G.pocketCells = []; G.pocketTo = [];

    const caps = G.caps = G.COUNTRIES.map(c => ({ x: c.cap[0] * WORLD_W, y: c.cap[1] * WORLD_H }));

    // --- land height: one continent, noisy coast, guaranteed land at capitals
    const land = G.land = new Float32Array(N);
    const landTex = G.landTex = new Uint8Array(N);
    for (let iy = 0; iy < GH; iy++) for (let ix = 0; ix < GW; ix++) {
      const u = (ix + 0.5) / GW, v = (iy + 0.5) / GH;
      const e = hyp((u - 0.5) / 0.5, (v - 0.5) / 0.5);
      let h = 0.5 + (fbm(u * 8.5, v * 4.8, seed) - 0.5) * 1.15 + 0.38 - 0.75 * e * e;
      for (const c of G.COUNTRIES) {
        const d2 = ((u - c.cap[0]) * 1.78) ** 2 + (v - c.cap[1]) ** 2;
        h += 0.3 * Math.exp(-d2 / 0.0036);
      }
      const m = Math.min(u, 1 - u, v, 1 - v);
      h -= (1 - smoothstep(0, 0.06, m)) * 0.6;
      h = clamp(h, 0, 1);
      land[iy * GW + ix] = h;
      landTex[iy * GW + ix] = h * 255 + 0.5 | 0;
    }

    // --- provinces: voronoi cells of a jittered hex lattice. Some seeds are
    // dropped so neighbours absorb their space, giving cells of varied size.
    // Used for orders/UI only; the control field still moves freely across them.
    // The shader rebuilds the same cells from seedTex, so positions are derived
    // from the quantised bytes to keep CPU picking and GPU drawing identical.
    const seedTex = G.seedTex = new Uint8Array(PC * PR * 4);
    G.seedX = new Float32Array(PC * PR); G.seedY = new Float32Array(PC * PR);
    for (let r = 0; r < PR; r++) for (let c = 0; c < PC; c++) {
      const i = r * PC + c, jx = rnd() * 255 | 0, jy = rnd() * 255 | 0;
      const dropped = c % 2 === 0 && r % 2 === 0 && rnd() < 0.6;   // never two adjacent
      seedTex.set([jx, jy, dropped ? 0 : 255, 255], i * 4);
      G.seedX[i] = (c + 0.5 + 0.5 * (r & 1)) * PS + (jx / 255 * 2 - 1) * PJ * PS;
      G.seedY[i] = (r + 0.5) * PROW + (jy / 255 * 2 - 1) * PJ * PS;
    }
    buildProvinces();

    // --- initial ownership: noise-warped voronoi around capitals, then softened
    const ctl = G.ctl = new Float32Array(N * NC);
    for (let iy = 0; iy < GH; iy++) for (let ix = 0; ix < GW; ix++) {
      const x = (ix + 0.5) * CELL, y = (iy + 0.5) * CELL;
      let best = 0, bd = Infinity;
      for (let k = 0; k < NC; k++) {
        const d = hyp(x - caps[k].x, y - caps[k].y) + (fbm(x / 260, y / 260, seed + 50 + k * 7) - 0.5) * 620;
        if (d < bd) { bd = d; best = k; }
      }
      ctl[(iy * GW + ix) * NC + best] = 1;
    }
    blurCtl(3);

    G.pressure = new Float32Array(N * NC);
    G.ctlTex = new Uint8Array(N * NC);

    for (let k = 0; k < NC; k++) for (let i = 0; i < (G.COUNTRIES[k].start || T.startUnits); i++) G.spawnUnit(k, true);

    G.stats = { share: new Float32Array(NC), cx: new Float32Array(NC), cy: new Float32Array(NC), area: new Float32Array(NC) };
    G.computeStats();
    G.updateProvOwners();
    updateSupply(0);
  };

  // Province index (row * PC + col of its seed) at a world position, or -1.
  G.provAt = function (x, y) {
    const c0 = Math.floor(x / PS), r0 = Math.floor(y / PROW);
    let best = -1, bd = Infinity;
    for (let r = Math.max(0, r0 - 2); r <= Math.min(PR - 1, r0 + 2); r++) for (let c = Math.max(0, c0 - 2); c <= Math.min(PC - 1, c0 + 2); c++) {
      const i = r * PC + c;
      if (!G.seedTex[i * 4 + 2]) continue;
      const d = (G.seedX[i] - x) ** 2 + (G.seedY[i] - y) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  // Two bytes per texel at EDGE_RES world units per texel: distance to the
  // province border (world units, 0..EDGE_MAX -> 0..255) and terrain (0 plains,
  // 128 hills, 255 fortified). Baked once so the shader needs one sample.
  G.EDGE_RES = 2; G.EDGE_MAX = 10;
  G.bakeEdges = function () {
    const res = G.EDGE_RES, w = WORLD_W / res, h = Math.ceil(WORLD_H / res), out = new Uint8Array(w * h * 2);
    for (let i = 0; i < out.length; i += 2) out[i] = 255;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const x = (px + 0.5) * res, y = (py + 0.5) * res;
      if (G.land[Math.min(GH - 1, y / CELL | 0) * GW + Math.min(GW - 1, x / CELL | 0)] < 0.4) continue;
      const c0 = Math.floor(x / PS), r0 = Math.floor(y / PROW);
      let f1 = Infinity, f2 = Infinity, i1 = -1, i2 = -1;
      for (let r = Math.max(0, r0 - 2); r <= Math.min(PR - 1, r0 + 2); r++) for (let c = Math.max(0, c0 - 2); c <= Math.min(PC - 1, c0 + 2); c++) {
        const i = r * PC + c;
        if (!G.seedTex[i * 4 + 2]) continue;
        const d = (G.seedX[i] - x) ** 2 + (G.seedY[i] - y) ** 2;
        if (d < f1) { f2 = f1; i2 = i1; f1 = d; i1 = i; } else if (d < f2) { f2 = d; i2 = i; }
      }
      if (i2 < 0) continue;
      const e = (f2 - f1) / (2 * hyp(G.seedX[i2] - G.seedX[i1], G.seedY[i2] - G.seedY[i1]));
      out[(py * w + px) * 2] = Math.min(255, e / G.EDGE_MAX * 255);
      out[(py * w + px) * 2 + 1] = G.provTerr[i1] * 127.5;
    }
    return { data: out, w, h };
  };

  // Rally point per province: centroid of its land, snapped to the nearest of
  // its own land cells when the centroid falls outside (coasts, concave cells).
  function buildProvinces() {
    const prov = G.provinces = new Map(), owner = G.cellProv = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      const x = (i % GW + 0.5) * CELL, y = ((i / GW | 0) + 0.5) * CELL, id = owner[i] = G.provAt(x, y);
      if (id < 0 || G.land[i] <= 0.52) continue;
      let p = prov.get(id);
      if (!p) prov.set(id, p = { id, c: id % PC, r: id / PC | 0, x: 0, y: 0, n: 0, bd: Infinity, cells: [] });
      p.x += x; p.y += y; p.n++; p.cells.push(i);
    }
    for (const p of prov.values()) {
      p.cx = p.x / p.n; p.cy = p.y / p.n;
      // seed + nearby seeds: lets the shader test "inside this province" cheaply
      p.sx = G.seedX[p.id]; p.sy = G.seedY[p.id]; p.nb = [];
      for (let r = Math.max(0, p.r - 3); r <= Math.min(PR - 1, p.r + 3); r++) for (let c = Math.max(0, p.c - 3); c <= Math.min(PC - 1, p.c + 3); c++) {
        const i = r * PC + c;
        if (i !== p.id && G.seedTex[i * 4 + 2]) p.nb.push(G.seedX[i], G.seedY[i]);
      }
      const near = [];
      for (let i = 0; i < p.nb.length; i += 2) near.push([p.nb[i], p.nb[i + 1]]);
      near.sort((a, b) => hyp(a[0] - p.sx, a[1] - p.sy) - hyp(b[0] - p.sx, b[1] - p.sy));
      p.nb = near.slice(0, 16).flat();
      p.reach = 0;   // furthest any of its land lies from the seed
      for (const i of p.cells) p.reach = Math.max(p.reach, hyp((i % GW + 0.5) * CELL - p.sx, ((i / GW | 0) + 0.5) * CELL - p.sy));
      p.reach += CELL * 1.5;
    }
    const terr = G.provTerr = new Uint8Array(PC * PR);
    for (const p of prov.values()) p.terrain = terr[p.id] = fbm(p.cx / 330, p.cy / 330, G.seed + 99) > 0.61 ? 1 : 0;
    for (const c of G.caps) { const p = prov.get(G.provAt(c.x, c.y)); if (p) p.terrain = terr[p.id] = 2; }
    // land neighbours (share a border on the cell grid)
    for (const p of prov.values()) p.adj = new Set();
    const link = (a, b) => { if (a !== b && prov.has(a) && prov.has(b)) { prov.get(a).adj.add(b); prov.get(b).adj.add(a); } };
    for (let i = 0; i < N; i++) {
      if (G.land[i] <= 0.52) continue;
      if (i % GW < GW - 1 && G.land[i + 1] > 0.52) link(owner[i], owner[i + 1]);
      if (i + GW < N && G.land[i + GW] > 0.52) link(owner[i], owner[i + GW]);
    }
    G.provOwner = new Int8Array(PC * PR).fill(-1);
    G.cellCost = new Float32Array(N).fill(1);
    for (let i = 0; i < N; i++) if (owner[i] >= 0 && terr[owner[i]] === 1) G.cellCost[i] = 1.5;
    for (let i = 0; i < N; i++) {
      const p = G.land[i] > 0.52 && prov.get(owner[i]);
      if (!p) continue;
      const x = (i % GW + 0.5) * CELL, y = ((i / GW | 0) + 0.5) * CELL, d = (x - p.cx) ** 2 + (y - p.cy) ** 2;
      if (d < p.bd) { p.bd = d; p.x = x; p.y = y; }
    }
    // a capital province is judged (held, supplied, rallied to) at the capital itself,
    // so "who holds the city" and "who holds its province" can never disagree
    for (const c of G.caps) { const p = prov.get(G.provAt(c.x, c.y)); if (p) { p.x = c.x; p.y = c.y; } }
  }

  function blurCtl(passes) {
    const ctl = G.ctl, tmp = new Float32Array(ctl.length);
    for (let p = 0; p < passes; p++) {
      for (let iy = 0; iy < GH; iy++) for (let ix = 0; ix < GW; ix++) for (let k = 0; k < NC; k++) {
        let s = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          s += ctl[(clamp(iy + oy, 0, GH - 1) * GW + clamp(ix + ox, 0, GW - 1)) * NC + k];
        }
        tmp[(iy * GW + ix) * NC + k] = s / 9;
      }
      ctl.set(tmp);
    }
  }

  G.spawnUnit = function (k, instant, at, type) {
    const c = at || G.caps[k], rnd = G.rnd;
    let x = c.x, y = c.y;
    for (let t = 0; t < 40; t++) {
      const a = rnd() * Math.PI * 2, r = 40 + rnd() * (instant ? 170 : 70);
      const px = c.x + Math.cos(a) * r, py = c.y + Math.sin(a) * r;
      if (G.landAt(px, py) && G.ctlAt(k, px, py) > 0.6) { x = px; y = py; break; }
    }
    const u = { id: G.nextId++, k, type: type || 'infantry', x, y, tx: x, ty: y, hasTarget: false, prov: -1, holdIds: [], ahead: -1, here: -1, dig: 0, foes: 0, hurt: 0, str: 1, age: instant ? 1 : 0, sup: 2, stance: 'attack', retreat: G.isHuman(k) ? 'stand' : 'low', pursuit: 'line', focus: 'spread', move: 'edge', straight: false, aura: false, ghostT: 0, bumped: false, wasBumped: false, tired: 0, falling: null, friends: 0, bonus: 0, hx: 0, hy: 0, path: null, planT: 0, blocked: false, sel: false, ai: rnd() * 3, fighting: false };
    G.units.push(u);
    return u;
  };

  // Divisions muster at the capital, or - once it has fallen - in the firmly
  // held province closest to it.
  G.musterPoint = function (k) {
    const b = G.muster[k];
    if (b && (b.city || G.buildings.includes(b)) && G.ctlAt(k, b.x, b.y) > 0.5) return b;   // a barracks, or a captured capital
    if (G.ctlAt(k, G.caps[k].x, G.caps[k].y) > 0.5) return G.caps[k];
    let best = null, bd = Infinity;
    for (const p of G.provinces.values()) {
      const d = (p.x - G.caps[k].x) ** 2 + (p.y - G.caps[k].y) ** 2;
      if (d < bd && G.ctlAt(k, p.x, p.y) > 0.8) { bd = d; best = p; }
    }
    return best;
  };
  G.canRecruit = (k, type) => !G.dead[k] && G.money[k] >= G.unitCost(k, type || 'infantry') && !!G.musterPoint(k);
  G.recruit = function (k, type) {
    type = type || 'infantry';
    if (!G.canRecruit(k, type)) return null;
    G.money[k] -= G.unitCost(k, type);
    const u = G.spawnUnit(k, false, G.musterPoint(k), type);
    if (G.autoFront[k]) G.holdFront([u], null);
    return u;
  };

  // --- buildings
  G.canBuild = function (k, x, y) {
    if (!G.landAt(x, y) || G.ctlAt(k, x, y) < 0.8) return false;
    for (const b of G.buildings) if ((b.x - x) ** 2 + (b.y - y) ** 2 < 34 * 34) return false;
    return true;
  };
  G.build = function (k, type, x, y) {
    const def = G.BUILDINGS[type];
    if (G.dead[k] || G.money[k] < def.cost || !G.canBuild(k, x, y)) return null;
    G.money[k] -= def.cost;
    const b = { id: G.nextId++, k, type, x, y, age: 0, cool: 1.5, aim: 0, stock: G.SUPPLY.depot, linked: true };
    G.buildings.push(b);
    if (type === 'barracks') G.muster[k] = b;
    return b;
  };

  // Move `delta` of a cell's control to country k, taking it proportionally from the rest.
  function shiftCell(o, k, delta) {
    const ctl = G.ctl, others = 1 - ctl[o + k];
    if (others < 1e-5) return;
    delta = Math.min(delta, others);
    const scale = (others - delta) / others;
    for (let j = 0; j < NC; j++) if (j !== k) ctl[o + j] *= scale;
    ctl[o + k] += delta;
  }

  // Artillery aims just beyond the border (ground deeper in would only become a
  // pocket and fade back), preferring the stretch of front nearest an enemy unit.
  function pickTarget(b) {
    const R = G.BUILDINGS.artillery.range, r = Math.ceil(R / CELL), cx = b.x / CELL | 0, cy = b.y / CELL | 0;
    const cells = [];
    let dmin = Infinity;
    for (let iy = Math.max(0, cy - r); iy <= Math.min(GH - 1, cy + r); iy++) for (let ix = Math.max(0, cx - r); ix <= Math.min(GW - 1, cx + r); ix++) {
      const i = iy * GW + ix;
      if (G.land[i] <= 0.52 || G.ctl[i * NC + b.k] >= 0.5) continue;
      const x = (ix + 0.5) * CELL, y = (iy + 0.5) * CELL, d = hyp(x - b.x, y - b.y);
      if (d > R) continue;
      cells.push({ x, y, d });
      if (d < dmin) dmin = d;
    }
    const front = cells.filter(c => c.d <= dmin + 35);
    if (!front.length) return null;
    let foe = null, fd = (R + 40) ** 2;
    for (const u of G.units) { if (u.k === b.k) continue; const d = (u.x - b.x) ** 2 + (u.y - b.y) ** 2; if (d < fd) { fd = d; foe = u; } }
    if (!foe) return front[G.rnd() * front.length | 0];
    return front.reduce((best, c) => (c.x - foe.x) ** 2 + (c.y - foe.y) ** 2 < (best.x - foe.x) ** 2 + (best.y - foe.y) ** 2 ? c : best);
  }

  function impact(sh) {
    const A = sh.by || G.BUILDINGS.artillery, r = A.blast / CELL, cx = sh.x / CELL - 0.5, cy = sh.y / CELL - 0.5;
    for (let iy = Math.max(0, Math.floor(cy - r)); iy <= Math.min(GH - 1, Math.ceil(cy + r)); iy++) for (let ix = Math.max(0, Math.floor(cx - r)); ix <= Math.min(GW - 1, Math.ceil(cx + r)); ix++) {
      const q = ((ix - cx) / r) ** 2 + ((iy - cy) / r) ** 2;
      if (q >= 1) continue;
      const i = iy * GW + ix, id = G.cellProv[i], terr = id < 0 ? 0 : G.provTerr[id];
      shiftCell(i * NC, sh.k, A.power * (1 - q * q) * [1, 0.75, 0.5][terr]);
    }
    for (const u of G.units) {
      if (u.k !== sh.k && hyp(u.x - sh.x, u.y - sh.y) < A.blast * 1.3) u.str -= A.dmg * G.UNIT_TYPES[u.type].armor * (1 - T.digArmor * u.dig);
    }
    G.effects.push({ type: 'blast', x: sh.x, y: sh.y, k: sh.k, r: A.blast, t: 0, life: 0.7 });
  }

  // Enemy ground touching k's border within R of a point (so a hit joins k's
  // territory rather than making a pocket), preferring cells near an enemy unit.
  function pickFront(k, px, py, R) {
    const r = Math.ceil(R / CELL), cx = px / CELL | 0, cy = py / CELL | 0, ctl = G.ctl, out = [];
    for (let iy = Math.max(1, cy - r); iy <= Math.min(GH - 2, cy + r); iy++) for (let ix = Math.max(1, cx - r); ix <= Math.min(GW - 2, cx + r); ix++) {
      const i = iy * GW + ix;
      if (G.land[i] <= 0.52 || ctl[i * NC + k] >= 0.5) continue;
      if (ctl[(i - 1) * NC + k] < 0.5 && ctl[(i + 1) * NC + k] < 0.5 && ctl[(i - GW) * NC + k] < 0.5 && ctl[(i + GW) * NC + k] < 0.5) continue;
      const x = (ix + 0.5) * CELL, y = (iy + 0.5) * CELL;
      if ((x - px) ** 2 + (y - py) ** 2 <= R * R) out.push({ x, y });
    }
    if (!out.length) return null;
    const foes = G.units.filter(u => u.k !== k && (u.x - px) ** 2 + (u.y - py) ** 2 < (R + 40) ** 2);
    if (!foes.length || G.rnd() < 0.4) return out[G.rnd() * out.length | 0];
    const foe = foes[G.rnd() * foes.length | 0];
    return out.reduce((best, c) => (c.x - foe.x) ** 2 + (c.y - foe.y) ** 2 < (best.x - foe.x) ** 2 + (best.y - foe.y) ** 2 ? c : best);
  }

  G.canBuyJet = k => !G.dead[k] && G.money[k] >= G.JET.cost && G.ctlAt(k, G.caps[k].x, G.caps[k].y) > 0.5;
  G.buyJet = function (k) {
    if (!G.canBuyJet(k)) return null;
    G.money[k] -= G.JET.cost;
    const c = G.caps[k], j = { id: G.nextId++, k, x: c.x, y: c.y, h: -Math.PI / 2, state: 'ground', timer: 1, fuel: 0, cool: 0, trail: [], trailT: 0, age: 0 };
    G.jets.push(j);
    return j;
  };

  function stepJets(dt) {
    const J = G.JET;
    for (const j of G.jets) {
      const home = G.caps[j.k], mark = G.airMark[j.k];
      j.age += dt;
      if (j.state === 'ground') {
        j.x = home.x; j.y = home.y; j.trail.length = 0;
        if ((j.timer -= dt) <= 0 && mark) { j.state = 'out'; j.fuel = J.loiter; j.h = Math.atan2(mark.y - j.y, mark.x - j.x); }
        continue;
      }
      let ax, ay;
      if (j.state !== 'back' && !mark) j.state = 'back';
      if (j.state === 'back') {
        ax = home.x; ay = home.y;
        if (hyp(ax - j.x, ay - j.y) < 25) { j.state = 'ground'; j.timer = J.rearm; continue; }
      } else {
        const d = hyp(mark.x - j.x, mark.y - j.y);
        if (j.state === 'out' && d < 90) j.state = 'loiter';
        else if (j.state === 'loiter' && d > J.range + 80) j.state = 'out';   // marker was moved
        if (j.state === 'out') { ax = mark.x; ay = mark.y; }
        else {
          // circle the marker: aim at a point a little further round the orbit
          const a = Math.atan2(j.y - mark.y, j.x - mark.x) + 0.9;
          ax = mark.x + Math.cos(a) * 70; ay = mark.y + Math.sin(a) * 70;
          if ((j.fuel -= dt) <= 0) j.state = 'back';
          if ((j.cool -= dt) <= 0) {
            const t = pickFront(j.k, mark.x, mark.y, J.range);
            j.cool = t ? J.reload * (0.8 + 0.4 * G.rnd()) : 0.4;
            if (t) G.shells.push({ k: j.k, by: J, fast: true, x0: j.x, y0: j.y, x: t.x + (G.rnd() - 0.5) * 10, y: t.y + (G.rnd() - 0.5) * 10, t: 0, life: 0.28 });
          }
        }
      }
      let turn = Math.atan2(ay - j.y, ax - j.x) - j.h;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      j.h += clamp(turn, -J.turn * dt, J.turn * dt);
      j.x += Math.cos(j.h) * J.speed * dt; j.y += Math.sin(j.h) * J.speed * dt;
      if ((j.trailT -= dt) <= 0) { j.trailT = 0.04; j.trail.push(j.x, j.y); if (j.trail.length > 36) j.trail.splice(0, 2); }
    }
  }

  // --- winning and losing: hold an enemy capital for occupyTime and that
  // country capitulates - its forces disband and its land passes to the
  // conqueror. The last country standing wins.
  function stepCapitals(dt) {
    for (let k = 0; k < NC; k++) {
      if (G.dead[k]) continue;
      const c = G.caps[k];
      let by = k, b = G.ctlAt(k, c.x, c.y);
      for (let o = 0; o < NC; o++) { const v = G.ctlAt(o, c.x, c.y); if (v > b) { b = v; by = o; } }
      if (by !== k && b > 0.5 && !G.dead[by]) { if ((G.occupy[k] += dt / T.occupyTime) >= 1) capitulate(k, by); }
      else G.occupy[k] = Math.max(0, G.occupy[k] - dt / 6);
    }
    for (let n = G.annex.length - 1; n >= 0; n--) {
      const a = G.annex[n], ctl = G.ctl;
      for (let o = 0; o < ctl.length; o += NC) {
        const d = Math.min(ctl[o + a.k], 0.5 * dt);
        if (d > 0) { ctl[o + a.k] -= d; ctl[o + a.to] += d; }
      }
      if ((a.t += dt) > 2.5) G.annex.splice(n, 1);
    }
  }

  function capitulate(k, to) {
    G.dead[k] = true; G.occupy[k] = 0; G.muster[k] = null; G.airMark[k] = null;
    for (const u of G.units) if (u.k === k) G.effects.push({ type: 'death', x: u.x, y: u.y, k, t: 0, life: 0.6 });
    G.units = G.units.filter(u => u.k !== k);
    G.buildings = G.buildings.filter(b => b.k !== k);
    G.jets = G.jets.filter(j => j.k !== k);
    G.annex.push({ k, to, t: 0 });
    G.events.push({ type: 'capitulate', k, to });
    const alive = G.dead.map((d, i) => d ? -1 : i).filter(i => i >= 0);
    if (alive.length === 1) G.winner = alive[0];
  }

  function stepBuildings(dt) {
    for (let i = G.buildings.length - 1; i >= 0; i--) {
      const b = G.buildings[i];
      b.age += dt;
      if (G.ctlAt(b.k, b.x, b.y) < 0.3) {   // overrun
        G.effects.push({ type: 'blast', x: b.x, y: b.y, k: b.k, r: 22, t: 0, life: 0.7 });
        if (G.muster[b.k] === b) G.muster[b.k] = null;
        G.buildings.splice(i, 1);
        continue;
      }
      if (b.type !== 'artillery' || (b.cool -= dt) > 0) continue;
      const t = pickTarget(b);
      if (!t) { b.cool = 0.5; continue; }
      b.cool = G.BUILDINGS.artillery.reload * (0.9 + 0.2 * G.rnd());
      b.aim = Math.atan2(t.y - b.y, t.x - b.x);
      G.shells.push({ k: b.k, x0: b.x, y0: b.y, x: t.x + (G.rnd() - 0.5) * 14, y: t.y + (G.rnd() - 0.5) * 14, t: 0, life: 0.45 + t.d / 380 });
    }
    for (let i = G.shells.length - 1; i >= 0; i--) {
      const sh = G.shells[i];
      if ((sh.t += dt) >= sh.life) { impact(sh); G.shells.splice(i, 1); }
    }
  }

  // AI spending: pick something to save for, buy it when affordable, repeat.
  function aiSpend(k) {
    const rnd = G.rnd, count = t => G.buildings.filter(b => b.k === k && b.type === t).length;
    if (!G.aiGoal[k]) {
      const r = rnd();
      G.aiGoal[k] = r > 0.92 && !G.jets.some(j => j.k === k) ? 'jet' : r < 0.15 && count('artillery') < 2 ? 'artillery' : r < 0.24 && count('barracks') < (G.units.some(u => u.k === k && u.sup < 2) ? 3 : 1) ? 'barracks' : r < 0.4 ? 'guard' : 'infantry';
    }
    const goal = G.aiGoal[k];
    if (goal === 'jet') { if (G.buyJet(k)) G.aiGoal[k] = null; return; }
    if (G.UNIT_TYPES[goal]) { if (G.recruit(k, goal)) G.aiGoal[k] = null; return; }
    if (G.money[k] < G.BUILDINGS[goal].cost) return;
    // place it behind one of our frontline units: guns close, barracks further back
    const mine = G.units.filter(u => u.k === k && u.fighting), u = mine[rnd() * mine.length | 0], back = goal === 'artillery' ? 45 : 110;
    if (u) {
      const c = G.caps[k], d = hyp(c.x - u.x, c.y - u.y) || 1;
      if (G.build(k, goal, u.x + (c.x - u.x) / d * back, u.y + (c.y - u.y) / d * back)) { G.aiGoal[k] = null; return; }
    }
    if (rnd() < 0.02) G.aiGoal[k] = null;   // nowhere suitable: eventually give up and rethink
  }

  // Units only ever stand on land their country holds: they stop at the border,
  // push it, and follow it forward. A unit whose ground was taken from under it
  // is stranded and may only move back toward friendly control.
  function tryMove(u, dx, dy) {
    const nx = clamp(u.x + dx, 5, WORLD_W - 5), ny = clamp(u.y + dy, 5, WORLD_H - 5);
    const here = G.ctlAt(u.k, u.x, u.y);
    const ok = (x, y) => { if (!G.landAt(x, y)) return false; const c = G.ctlAt(u.k, x, y); return c >= 0.5 || (here < 0.5 && c > here); };
    if (ok(nx, ny)) { u.x = nx; u.y = ny; }
    else if (ok(nx, u.y)) u.x = nx;
    else if (ok(u.x, ny)) u.y = ny;
  }

  // Breadth-first distances (in provinces) from `sources` through provinces held by k.
  function spread(k, sources, dist, parent, skip) {
    dist.fill(-1); if (parent) parent.fill(-1);
    const q = [];
    for (const id of sources) if (id !== skip && dist[id] < 0) { dist[id] = 0; q.push(id); }
    for (let h = 0; h < q.length; h++) {
      const id = q[h];
      for (const a of G.provinces.get(id).adj) {
        if (a === skip || dist[a] >= 0 || G.provOwner[a] !== k) continue;
        dist[a] = dist[id] + 1; if (parent) parent[a] = id; q.push(a);
      }
    }
  }
  const provIdAt = (x, y) => G.cellProv[clamp(y / CELL | 0, 0, GH - 1) * GW + clamp(x / CELL | 0, 0, GW - 1)];
  const levelOf = d => d < 0 ? 0 : d <= G.SUPPLY.full ? 2 : d <= G.SUPPLY.strained ? 1 : 0;

  // A unit draws on the province it stands in, or - standing on the rim of a
  // province someone else mostly holds - on the best neighbouring one of its own.
  function unitDist(u, dist) {
    const id = provIdAt(u.x, u.y);
    if (id < 0 || !G.provinces.has(id)) return 0;   // sliver of coast outside any land province: don't starve on a technicality
    if (G.provOwner[id] === u.k) return dist[id];
    let best = -1;
    for (const a of G.provinces.get(id).adj) if (G.provOwner[a] === u.k && dist[a] >= 0 && (best < 0 || dist[a] < best)) best = dist[a];
    return best < 0 ? -1 : best + 1;
  }

  function supplySources(k, dt) {
    // every capital province k holds - its own or a captured one - is a main city and feeds supply
    const src = [];
    for (let j = 0; j < NC; j++) { const capId = provIdAt(G.caps[j].x, G.caps[j].y); if (G.provOwner[capId] === k) src.push(capId); }
    // which barracks are still linked to the capital?
    const link = new Int16Array(PC * PR);
    spread(k, src, link, null, -1);
    for (const b of G.buildings) {
      if (b.k !== k || b.type !== 'barracks') continue;
      const id = provIdAt(b.x, b.y);
      if (G.provOwner[id] !== k) continue;
      b.linked = link[id] >= 0;
      b.stock = b.linked ? Math.min(G.SUPPLY.depot, b.stock + 2 * dt) : Math.max(0, b.stock - dt);
      if (b.linked || b.stock > 0) src.push(id);
    }
    return src;
  }

  function updateSupply(dt) {
    for (let k = 0; k < NC; k++) {
      if (G.dead[k]) continue;
      spread(k, supplySources(k, dt), G.supDist[k], G.supParent[k], -1);
      // distance from the front: provinces k does not hold are 0, its border provinces 1, ...
      const enemy = [];
      for (const p of G.provinces.values()) if (G.provOwner[p.id] !== k) enemy.push(p.id);
      spread(k, enemy, G.frontDist[k], null, -1);
    }
    const cut = new Array(NC).fill(0), where = new Array(NC).fill(null);
    for (const u of G.units) {
      const was = u.sup;
      u.sup = levelOf(unitDist(u, G.supDist[u.k]));
      if (was > 0 && u.sup === 0) { cut[u.k]++; where[u.k] = u; }
    }
    for (let k = 0; k < NC; k++) if (cut[k]) G.events.push({ type: 'cutoff', k, n: cut[k], x: where[k].x, y: where[k].y });
  }

  // For the supply overlay: k's held provinces with their level and route, plus
  // chokepoints - provinces whose loss alone would cut off n of k's units.
  G.supplyReport = function (k) {
    const dist = G.supDist[k], nodes = [], chokes = [], src = supplySources(k, 0), tmp = new Int16Array(PC * PR);
    for (const p of G.provinces.values()) if (G.provOwner[p.id] === k) nodes.push({ p, level: levelOf(dist[p.id]), parent: G.provinces.get(G.supParent[k][p.id]) || null, source: dist[p.id] === 0 });
    const mine = G.units.filter(u => u.k === k && u.sup > 0);
    for (const n of nodes) {
      if (n.source || dist[n.p.id] < 0) continue;
      spread(k, src, tmp, null, n.p.id);
      let lost = 0;
      for (const u of mine) if (provIdAt(u.x, u.y) !== n.p.id && levelOf(unitDist(u, tmp)) === 0) lost++;
      if (lost) chokes.push({ p: n.p, n: lost });
    }
    return { nodes, chokes };
  };

  // AI: defend the capital if it is threatened, otherwise attack one of the
  // nearest enemy-held provinces. That spreads units along the front instead
  // of piling everything onto the closest enemy.
  function think(u) {
    const rnd = G.rnd, home = G.caps[u.k], dist = G.supDist[u.k];
    const walk = t => {   // far away: go one province at a time
      const d = hyp(t.x - u.x, t.y - u.y) || 1, s = Math.min(d, PS * 1.4);
      const sx = u.x + (t.x - u.x) / d * s, sy = u.y + (t.y - u.y) / d * s, step = d > PS * 1.8 && G.landAt(sx, sy) && G.provinces.get(G.provAt(sx, sy));
      const go = step || t;
      G.holdProvince([u], go);
    };
    if (u.sup === 0) {   // cut off: fight back toward the nearest supplied ground
      let best = null, bd = Infinity;
      for (const p of G.provinces.values()) {
        if (G.provOwner[p.id] !== u.k || levelOf(dist[p.id]) === 0) continue;
        const d = hyp(p.x - u.x, p.y - u.y);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) return walk(best);
    }
    if (hyp(u.x - home.x, u.y - home.y) < 450) {
      for (const o of G.units) {
        if (o.k === u.k || hyp(o.x - home.x, o.y - home.y) > 220) continue;
        const p = G.provinces.get(G.provAt(o.x, o.y));
        if (p) return G.order(u, p.x, p.y, p.id);
      }
    }
    const near = [];
    for (const p of G.provinces.values()) {
      if (G.ctlAt(u.k, p.x, p.y) >= 0.5) continue;
      let d = hyp(p.x - u.x, p.y - u.y) * (p.terrain === 1 ? 1.3 : 1);
      // thin enemy ground (a neck or the tip of a salient) is worth going for: taking it cuts things off
      const owner = G.provOwner[p.id];
      let same = 0, reach = false;
      for (const a of p.adj) { if (owner >= 0 && G.provOwner[a] === owner) same++; if (G.provOwner[a] === u.k && levelOf(dist[a]) > 0) reach = true; }
      if (owner >= 0 && same <= 2) d *= 0.7;
      if (!reach) d *= 2.5;   // we could not supply a push there
      near.push({ p, d });
    }
    if (!near.length) return;
    near.sort((a, b) => a.d - b.d);
    walk(near[rnd() * Math.min(4, near.length) | 0].p);
  }

  // prov = the province this order pushes into (-1: work it out from the target)
  G.order = function (u, x, y, prov, keepMode) {
    if (!keepMode) {
      if (u.mode === 'front' && u.prevStance) { u.stance = u.prevStance; u.prevStance = null; }
      u.mode = null; u.holdIds = []; u.falling = null;
    }
    u.tx = x; u.ty = y; u.hasTarget = true; u.path = null; u.planT = 0; u.blocked = false; u.straight = false;
    u.prov = prov >= 0 ? prov : G.provAt(x, y);
  };

  // March straight at province p as the units stand (formation kept, no routing, no
  // lining of edges), pushing whatever ground is in the way. keepMode: leave a
  // hold-the-front unit in that mode.
  function marchStraight(units, p, keepMode) {
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x / units.length; cy += u.y / units.length; }
    for (const u of units) {
      let ox = u.x - cx, oy = u.y - cy;
      const ol = hyp(ox, oy), lim = Math.min(ol, 70) / (ol || 1);
      ox *= lim; oy *= lim;
      // keep the formation, but shrink it until the spot is land inside the province that was asked for
      let f = 1;
      while (f > 0.1 && !(G.landAt(p.x + ox * f, p.y + oy * f) && G.provAt(p.x + ox * f, p.y + oy * f) === p.id)) f *= 0.6;
      if (f <= 0.1) f = 0;
      G.order(u, p.x + ox * f, p.y + oy * f, p.id, keepMode);
      u.holdIds = []; u.straight = true;
    }
  }

  // Changing the movement setting converts whatever the units are doing right now.
  G.setMove = function (units, val) {
    for (const u of units) u.move = val;
    if (val === 'straight') { G.holdT = 0; return; }   // stepHold converts edge orders on its next pass
    const byProv = new Map();
    for (const u of units) if (u.straight && u.prov >= 0 && G.provinces.has(u.prov)) { if (!byProv.has(u.prov)) byProv.set(u.prov, []); byProv.get(u.prov).push(u); }
    for (const [id, us] of byProv) G.holdProvince(us, G.provinces.get(id));
  };

  // who holds capital j's province right now (-1: contested)
  G.cityOwner = j => G.provOwner[provIdAt(G.caps[j].x, G.caps[j].y)];

  G.isHuman = k => G.net ? G.humans.has(k) : k === G.player;

  // ---------- commands: everything a player can do to the simulation, as plain
  // data. The UI never touches sim state directly - it issues these, so the same
  // orders can be sent over the network, applied on every machine at the same
  // tick, and logged. Returns whatever the UI may want to ping (a new unit/building).
  const SETTINGS = { stance: G.STANCES, retreat: G.RETREATS, pursuit: G.PURSUITS, focus: G.FOCUSES };
  G.exec = function (k, c) {
    if (G.dead[k] && c.t !== 'drop') return null;
    const mine = ids => { const want = new Set(ids), out = []; for (const u of G.units) if (u.k === k && want.has(u.id)) out.push(u); return out; };
    switch (c.t) {
      // 'hold' = attack/move into a province; 'guard' = the same move, but arriving in Hold stance:
      // line the province's enemy-facing edge, dig in, don't push. A later attack order
      // puts a guarding unit back on the stance it had before.
      case 'hold': case 'guard': {
        const us = mine(c.ids), p = G.provinces.get(c.p);
        if (!us.length || !p) return null;
        for (const u of us) {
          if (c.t === 'guard') { if (!u.guard) { u.guard = true; u.guardPrev = u.stance; } u.stance = 'hold'; }
          else if (u.guard) { u.guard = false; u.stance = u.guardPrev || 'attack'; }
        }
        G.holdProvince(us, p, !!c.add); return null;
      }
      case 'line': {   // drawn formation: one spot per unit
        const byId = new Map(mine(c.slots.map(q => q.id)).map(u => [u.id, u]));
        for (const q of c.slots) { const u = byId.get(q.id); if (u) { G.order(u, clamp(q.x, 0, WORLD_W), clamp(q.y, 0, WORLD_H), -1); if (u.move === 'straight') u.straight = true; } }
        return null;
      }
      case 'front': { const us = mine(c.ids); if (us.length) G.holdFront(us, c.dir || null); return null; }
      case 'set': {
        if (!SETTINGS[c.key] || !SETTINGS[c.key][c.val]) return null;
        for (const u of mine(c.ids)) { u[c.key] = c.val; if (c.key === 'stance') { u.prevStance = null; u.guard = false; } }   // an explicit stance sticks
        G.holdT = 0; return null;
      }
      case 'move': if (G.MOVES[c.val]) G.setMove(mine(c.ids), c.val); return null;
      case 'stop': G.stop(mine(c.ids)); return null;
      case 'recruit': return G.UNIT_TYPES[c.type] ? G.recruit(k, c.type) : null;
      case 'build': return G.BUILDINGS[c.type] ? G.build(k, c.type, c.x, c.y) : null;
      case 'jet': return G.buyJet(k);
      case 'airmark': G.airMark[k] = { x: clamp(c.x, 0, WORLD_W), y: clamp(c.y, 0, WORLD_H) }; return null;
      case 'autofront': G.autoFront[k] = !!c.on; return null;
      case 'muster':   // a barracks (id), a captured capital (cap), or back to the home capital (neither)
        if (c.cap != null && c.cap !== k && G.caps[c.cap] && G.cityOwner(c.cap) === k) G.muster[k] = { city: true, cap: c.cap, x: G.caps[c.cap].x, y: G.caps[c.cap].y };
        else G.muster[k] = c.id == null ? null : G.buildings.find(b => b.id === c.id && b.k === k && b.type === 'barracks') || null;
        return null;
      case 'drop': G.humans.delete(c.k); return null;   // a player left: the AI takes that country over
    }
    return null;
  };

  // ---------- checksum + save/load, for keeping network games in step
  G.checksum = function () {
    let h = G.rndState | 0;
    const mix = v => { h = Math.imul(h ^ (v | 0), 0x01000193) + 0x9e3779b9 | 0; };
    for (const u of G.units) { mix(u.id); mix(u.x * 4096); mix(u.y * 4096); mix(u.str * 65536); }
    for (const b of G.buildings) { mix(b.id); mix(b.cool * 4096); }
    for (let k = 0; k < NC; k++) mix(G.money[k] * 256);
    for (let i = 0; i < G.ctl.length; i += 37) mix(G.ctl[i] * 65536);
    return h >>> 0;
  };

  const TYPED = ['money', 'income', 'aiAir', 'occupy', 'provOwner'];
  G.serialize = function () {
    const meta = {
      seed: G.seed, time: G.time, rndState: G.rndState, nextId: G.nextId, statT: G.statT, holdT: G.holdT, winner: G.winner,
      humans: [...G.humans], dead: G.dead, aiGoal: G.aiGoal, airMark: G.airMark, autoFront: G.autoFront, annex: G.annex,
      muster: G.muster.map(b => b ? (b.city ? { cap: b.cap } : b.id) : null), pocketCells: G.pocketCells, pocketTo: G.pocketTo,
      stats: { share: [...G.stats.share], cx: [...G.stats.cx], cy: [...G.stats.cy], area: [...G.stats.area] },
      supDist: G.supDist.map(a => [...a]), supParent: G.supParent.map(a => [...a]), frontDist: G.frontDist.map(a => [...a]),
      units: G.units.map(u => ({ ...u, sel: false, avoid: u.avoid ? [...u.avoid] : null })),
      buildings: G.buildings, jets: G.jets, shells: G.shells.map(sh => ({ ...sh, by: sh.by ? 'jet' : null })),
    };
    for (const n of TYPED) meta[n] = [...G[n]];
    return { meta: JSON.parse(JSON.stringify(meta)), ctl: new Float32Array(G.ctl) };
  };
  G.deserialize = function (snap) {
    const m = snap.meta;
    if (m.seed !== G.seed) G.init(m.seed);
    G.ctl.set(snap.ctl);
    for (const n of ['time', 'rndState', 'nextId', 'statT', 'holdT', 'winner', 'dead', 'aiGoal', 'airMark', 'autoFront', 'annex', 'pocketCells', 'pocketTo']) G[n] = m[n];
    for (const n of TYPED) G[n].set(m[n]);
    for (const n of ['share', 'cx', 'cy', 'area']) G.stats[n].set(m.stats[n]);
    m.supDist.forEach((a, k) => G.supDist[k].set(a)); m.supParent.forEach((a, k) => G.supParent[k].set(a)); m.frontDist.forEach((a, k) => G.frontDist[k].set(a));
    G.humans = new Set(m.humans);
    const keepSel = new Set(G.units.filter(u => u.sel).map(u => u.id));
    G.units = m.units.map(u => ({ ...u, sel: keepSel.has(u.id), avoid: u.avoid ? new Set(u.avoid) : undefined }));
    G.buildings = m.buildings; G.jets = m.jets;
    G.shells = m.shells.map(sh => ({ ...sh, by: sh.by ? G.JET : undefined }));
    G.muster = m.muster.map(id => id == null ? null : id.cap != null ? { city: true, cap: id.cap, x: G.caps[id.cap].x, y: G.caps[id.cap].y } : G.buildings.find(b => b.id === id) || null);
    G.effects = []; G.clashes = []; G.events = [];
  };

  G.stop = function (units) {
    for (const u of units) {
      if (u.mode === 'front' && u.prevStance) { u.stance = u.prevStance; u.prevStance = null; }
      u.mode = null; u.holdIds = []; u.falling = null; u.hasTarget = false; u.prov = -1; u.path = null; u.straight = false;
    }
  };

  // --- holding a province: units ordered into a province line its edges that
  // face enemy ground instead of bunching in the middle. While the province is
  // being taken that edge is the advancing front inside it; once taken it is the
  // province's outer border with the enemy. Re-spread every so often as it moves.
  // add = extend the units' current order with p (shift-click): they then form
  // one line along the enemy-facing edge of all those provinces and push them all.
  G.holdProvince = function (units, p, add) {
    const ids = [];
    if (add) for (const u of units) for (const id of u.holdIds) if (!ids.includes(id)) ids.push(id);
    if (!ids.includes(p.id)) ids.push(p.id);
    // "straight in" units don't line the edge: they march at the province as they
    // stand (keeping their formation) and push whatever ground is in front of them
    const direct = units.filter(u => u.move === 'straight'), rest = units.filter(u => u.move !== 'straight');
    marchStraight(direct, p);
    for (const u of rest) {
      if (u.mode === 'front' && u.prevStance) { u.stance = u.prevStance; u.prevStance = null; }
      u.mode = null; u.falling = null; u.holdIds = ids; u.prov = p.id;
    }
    if (rest.length) spreadOnProvinces(rest[0].k, ids, rest);
  };

  // k's ground along the enemy inside or right beside the given provinces;
  // each cell remembers which of them it fronts.
  function frontCells(k, ids) {
    const ctl = G.ctl, out = [], seen = new Set();
    const own = i => ctl[i * NC + k] >= 0.5, land = i => i >= 0 && i < N && G.land[i] > 0.52;
    for (const id of ids) {
      const p = G.provinces.get(id);
      if (!p) continue;
      for (const i of p.cells) {
        const nb = [i - 1, i + 1, i - GW, i + GW];
        if (own(i)) { if (nb.some(n => land(n) && !own(n))) out.push({ i, id }); }
        else for (const n of nb) if (land(n) && own(n) && !ids.includes(G.cellProv[n]) && !seen.has(n)) { seen.add(n); out.push({ i: n, id }); }
      }
    }
    return out;
  }

  // Can a unit of k walk straight from (x0,y0) to (x1,y1) over its own ground?
  function walkable(k, x0, y0, x1, y1) {
    const d = hyp(x1 - x0, y1 - y0), n = Math.ceil(d / CELL);
    for (let j = 1; j < n; j++) {
      const x = x0 + (x1 - x0) * j / n, y = y0 + (y1 - y0) * j / n, i = (y / CELL | 0) * GW + (x / CELL | 0);
      if (G.land[i] <= 0.52 || G.ctl[i * NC + k] < 0.5) return false;
    }
    return true;
  }

  // --- pathfinding: A* over the cells a country may stand on (its own land;
  // hills cost more). Returns waypoints, pulled tight so units cut corners
  // wherever the straight line is clear. If the goal can't be reached the path
  // leads to the closest point that can.
  const pfG = new Float32Array(N), pfFrom = new Int32Array(N), pfSeen = new Uint32Array(N), pfDone = new Uint32Array(N);
  const heapI = [], heapF = [];
  let pfGen = 0;
  function heapPush(i, f) {
    let c = heapI.length; heapI.push(i); heapF.push(f);
    while (c > 0) { const q = (c - 1) >> 1; if (heapF[q] <= f) break; heapI[c] = heapI[q]; heapF[c] = heapF[q]; c = q; }
    heapI[c] = i; heapF[c] = f;
  }
  function heapPop() {
    const top = heapI[0], li = heapI.pop(), lf = heapF.pop(), n = heapI.length;
    if (n) {
      let c = 0;
      for (;;) {
        let ch = 2 * c + 1; if (ch >= n) break;
        if (ch + 1 < n && heapF[ch + 1] < heapF[ch]) ch++;
        if (heapF[ch] >= lf) break;
        heapI[c] = heapI[ch]; heapF[c] = heapF[ch]; c = ch;
      }
      heapI[c] = li; heapF[c] = lf;
    }
    return top;
  }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  function findPath(k, x0, y0, x1, y1) {
    const ctl = G.ctl, land = G.land, ok = i => land[i] > 0.52 && ctl[i * NC + k] >= 0.5;
    const sx = clamp(x0 / CELL | 0, 0, GW - 1), sy = clamp(y0 / CELL | 0, 0, GH - 1), gx = clamp(x1 / CELL | 0, 0, GW - 1), gy = clamp(y1 / CELL | 0, 0, GH - 1);
    const start = sy * GW + sx, goal = gy * GW + gx, gen = ++pfGen;
    const h = (x, y) => { const ax = Math.abs(x - gx), ay = Math.abs(y - gy); return Math.max(ax, ay) + 0.414 * Math.min(ax, ay); };
    heapI.length = heapF.length = 0;
    pfG[start] = 0; pfFrom[start] = -1; pfSeen[start] = gen; heapPush(start, h(sx, sy));
    let best = start, bestH = h(sx, sy), reached = false;
    for (let n = 0; heapI.length && n < 12000; n++) {
      const cur = heapPop();
      if (pfDone[cur] === gen) continue;
      pfDone[cur] = gen;
      if (cur === goal) { reached = true; best = cur; break; }
      const cx = cur % GW, cy = cur / GW | 0, hc = h(cx, cy);
      if (hc < bestH) { bestH = hc; best = cur; }
      for (let d = 0; d < 8; d++) {
        const nx = cx + DX[d], ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
        const ni = ny * GW + nx;
        if (pfDone[ni] === gen || !ok(ni)) continue;
        if (d > 3 && (!ok(cy * GW + nx) || !ok(ny * GW + cx))) continue;   // no squeezing diagonally past a corner
        const g = pfG[cur] + (d > 3 ? 1.414 : 1) * G.cellCost[ni];
        if (pfSeen[ni] === gen && g >= pfG[ni]) continue;
        pfG[ni] = g; pfFrom[ni] = cur; pfSeen[ni] = gen; heapPush(ni, g + h(nx, ny));
      }
    }
    const cells = [];
    for (let c = best; c >= 0 && c !== start; c = pfFrom[c]) cells.push(c);
    cells.reverse();
    const raw = cells.map(c => ({ x: (c % GW + 0.5) * CELL, y: ((c / GW | 0) + 0.5) * CELL }));
    if (reached && raw.length) raw[raw.length - 1] = { x: x1, y: y1 };
    // pull the string tight
    const pts = [];
    let fx = x0, fy = y0, i = 0;
    while (i < raw.length) {
      let j = Math.min(raw.length - 1, i + 60);
      while (j > i && !walkable(k, fx, fy, raw[j].x, raw[j].y)) j--;
      pts.push(raw[j]); fx = raw[j].x; fy = raw[j].y; i = j + 1;
    }
    return { pts, reached };
  }

  function replan(u) {
    if (walkable(u.k, u.x, u.y, u.tx, u.ty)) { u.path = []; u.blocked = false; u.planT = 1.2; return; }
    const r = findPath(u.k, u.x, u.y, u.tx, u.ty), gi = clamp(u.ty / CELL | 0, 0, GH - 1) * GW + clamp(u.tx / CELL | 0, 0, GW - 1);
    u.path = r.pts;
    // blocked = the spot is on our own ground yet nothing we hold connects to it
    u.blocked = !r.reached && G.land[gi] > 0.52 && G.ctl[gi * NC + u.k] >= 0.5;
    u.planT = r.reached ? 1.2 : 4;   // hopeless searches are the expensive ones: retry those rarely
  }

  // --- spots along the edge
  // rows: more units than picked points -> further rows behind the edge, on our side
  function rowsBehind(k, picked, units) {
    const n = units.length, slots = [];
    let mx = 0, my = 0;
    for (const u of units) { mx += u.x / n; my += u.y / n; }
    for (let i = 0; i < n; i++) {
      const base = picked[i % picked.length], row = i / picked.length | 0;
      if (!row) { slots.push(base); continue; }
      const d = hyp(mx - base.x, my - base.y) || 1;
      let x = base.x, y = base.y;
      for (const turn of [0, 0.7, -0.7, 1.4, -1.4]) {
        const c = Math.cos(turn), sn = Math.sin(turn), vx = (mx - base.x) / d, vy = (my - base.y) / d;
        const tx = base.x + (vx * c - vy * sn) * 28 * row, ty = base.y + (vx * sn + vy * c) * 28 * row;
        if (G.landAt(tx, ty) && G.ctlAt(k, tx, ty) >= 0.5) { x = tx; y = ty; break; }
      }
      slots.push({ x, y, id: base.id });
    }
    return slots;
  }

  // spread: well-separated points along the whole edge (farthest-point sampling),
  // seeded from the first unit so the pattern stays put between refreshes
  function lineSlots(k, pts, units) {
    for (const q of pts) q.d = Infinity;
    let cur = pts.reduce((b, q) => (q.x - units[0].x) ** 2 + (q.y - units[0].y) ** 2 < (b.x - units[0].x) ** 2 + (b.y - units[0].y) ** 2 ? q : b);
    const picked = [];
    for (let i = 0; i < Math.min(units.length, pts.length); i++) {
      picked.push(cur);
      let far = pts[0];
      for (const q of pts) { q.d = Math.min(q.d, (q.x - cur.x) ** 2 + (q.y - cur.y) ** 2); if (q.d > far.d) far = q; }
      cur = far;
    }
    return rowsBehind(k, picked, units);
  }

  // concentrate: mass on the weakest point of the edge - the stretch furthest from any enemy unit
  function massSlots(k, pts, units) {
    const foes = G.units.filter(o => o.k !== k);
    let mx = 0, my = 0;
    for (const u of units) { mx += u.x / units.length; my += u.y / units.length; }
    let anchor = pts[0], bs = -Infinity;
    for (const q of pts) {
      let near = 1e9;
      for (const o of foes) near = Math.min(near, hyp(o.x - q.x, o.y - q.y));
      const sc = Math.min(near, 400) - 0.35 * hyp(q.x - mx, q.y - my);   // weak, but not at the other end of the map
      if (sc > bs) { bs = sc; anchor = q; }
    }
    const byDist = pts.slice().sort((a, b) => hyp(a.x - anchor.x, a.y - anchor.y) - hyp(b.x - anchor.x, b.y - anchor.y)), picked = [];
    for (const q of byDist) { if (picked.length >= units.length) break; if (picked.every(o => hyp(o.x - q.x, o.y - q.y) >= 24)) picked.push(q); }
    return rowsBehind(k, picked.slice(0, Math.max(1, Math.min(picked.length, 4))), units);
  }

  // Match units to spots so the total walking distance is as small as we can make
  // it: greedy start, then swap any pair whose swap shortens the total. Crossing
  // paths always get shorter when swapped, so at the end none cross.
  function assign(units, slots) {
    const n = units.length;
    const M = units.map(u => slots.map(sl => hyp(u.x - sl.x, u.y - sl.y)));
    const left = units.map((_, i) => i), idx = [];
    for (let si = 0; si < n; si++) {
      let bi = 0;
      for (let q = 1; q < left.length; q++) if (M[left[q]][si] < M[left[bi]][si]) bi = q;
      idx.push(left.splice(bi, 1)[0]);
    }
    for (let pass = 0, improved = true; improved && pass < 12; pass++) {
      improved = false;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        if (M[idx[j]][i] + M[idx[i]][j] < M[idx[i]][i] + M[idx[j]][j] - 0.5) { [idx[i], idx[j]] = [idx[j], idx[i]]; improved = true; }
      }
    }
    idx.forEach((ui, i) => {
      const u = units[ui], sl = slots[i];
      u.prov = sl.id;   // the stretch this unit leans on
      // leave a unit alone if its spot barely moved, so it can settle and dig in
      if (hyp(u.tx - sl.x, u.ty - sl.y) > 14 || (!u.hasTarget && hyp(u.x - sl.x, u.y - sl.y) > 14)) G.order(u, sl.x, sl.y, sl.id, true);
    });
  }

  function spreadOnProvinces(k, ids, units) {
    // only the stretch of edge on our side: spots some unit of the group can walk straight to
    const all = frontCells(k, ids), n = units.length;
    const at = c => [(c.i % GW + 0.5) * CELL, ((c.i / GW | 0) + 0.5) * CELL];
    const near = all.filter(c => { const [x, y] = at(c); return units.some(u => walkable(k, u.x, u.y, x, y)); });
    const cells = near.length ? near : all;
    if (!cells.length) {   // nothing hostile touches them: gather round the middle of the first
      const p = G.provinces.get(ids[0]), slots = [];
      for (let i = 0; i < n; i++) {
        const r = 16 * Math.sqrt(i), a = i * 2.4;
        let x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r;
        if (!G.landAt(x, y)) { x = p.x; y = p.y; }
        slots.push({ x, y, id: p.id });
      }
      return assign(units, slots);
    }
    const pts = cells.map(c => ({ x: (c.i % GW + 0.5) * CELL, y: ((c.i / GW | 0) + 0.5) * CELL, id: c.id, d: Infinity }));
    const mass = units.filter(u => u.focus === 'mass'), line = units.filter(u => u.focus !== 'mass');
    if (line.length) assign(line, lineSlots(k, pts, line));
    if (mass.length) assign(mass, massSlots(k, pts, mass));
  }

  // nearest province next to `ids` that k doesn't hold and nobody is defending
  function undefendedNext(k, ids, units) {
    let cx = 0, cy = 0;
    for (const u of units) { cx += u.x / units.length; cy += u.y / units.length; }
    let next = null, bd = Infinity;
    for (const id of ids) for (const a of G.provinces.get(id).adj) {
      if (G.provOwner[a] === k) continue;
      const q = G.provinces.get(a);
      if (G.units.some(o => o.k !== k && hyp(o.x - q.x, o.y - q.y) < PS * 0.9)) continue;   // defended: that needs an order
      const d = hyp(q.x - cx, q.y - cy);
      if (d < bd) { bd = d; next = q; }
    }
    return next;
  }

  function stepHold(dt) {
    if ((G.holdT -= dt) > 0) return;
    G.holdT = 1.2;
    const groups = new Map();
    for (const u of G.units) {
      if (!u.holdIds.length || u.sup === 0 || u.falling) continue;
      const key = u.k + ':' + u.holdIds.join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(u);
    }
    // "straight in" units that arrived and are set to exploit: on to the next undefended province
    const onward = new Map();
    for (const u of G.units) {
      if (u.move !== 'straight' || u.pursuit !== 'exploit' || u.prov < 0 || u.falling || u.mode === 'front' || u.sup !== 2 || G.provOwner[u.prov] !== u.k) continue;
      const key = u.k * 100000 + u.prov;
      if (!onward.has(key)) onward.set(key, []);
      onward.get(key).push(u);
    }
    for (const us of onward.values()) { const next = undefendedNext(us[0].k, [us[0].prov], us); if (next) marchStraight(us, next); }

    for (const all of groups.values()) {
      const k = all[0].k, ids = all[0].holdIds;
      // units switched to "straight in" while holding an edge order: convert it
      const direct = all.filter(u => u.move === 'straight'), us = all.filter(u => u.move !== 'straight');
      if (direct.length) marchStraight(direct, G.provinces.get(ids.find(id => G.provOwner[id] !== k) ?? ids[0]), direct[0].mode === 'front');
      if (!us.length) continue;
      // exploit: everything ordered is taken -> roll on into a neighbouring province
      // nobody is defending, for as long as supply keeps up
      const keen = us.filter(u => u.pursuit === 'exploit' && u.sup === 2 && u.mode !== 'front');
      if (keen.length && ids.every(id => G.provOwner[id] === k)) {
        const next = undefendedNext(k, ids, keen);
        if (next) { const nid = [next.id]; for (const u of keen) { u.holdIds = nid; u.prov = next.id; } spreadOnProvinces(k, nid, keen); }
        const rest = us.filter(u => !keen.includes(u) || !next);
        if (rest.length) spreadOnProvinces(k, ids, rest);
        continue;
      }
      spreadOnProvinces(k, ids, us);
    }
  }

  // --- falling back: a unit that is weak (or badly outnumbered) and allowed to
  // withdraws one province toward its supply source, recovers, then goes back
  // to what it was doing.
  function stepRetreat(u, dt) {
    const B = G.BEHAVIOUR;
    if (!u.falling) {
      if (u.retreat === 'stand' || u.sup === 0) return;
      const weak = u.retreat === 'low' && u.str < B.fallBelow && u.fighting;
      const swamped = u.retreat === 'outnumbered' && u.foes >= 2 && u.foes >= 2 * (u.friends + 1);
      if (!weak && !swamped) return;
      const pid = provIdAt(u.x, u.y), back = G.provinces.get(G.supParent[u.k][pid]);
      if (!back) return;   // nowhere behind us (already at the source, or cut off)
      const saved = { holdIds: u.holdIds, mode: u.mode, x: u.x, y: u.y, why: weak ? 'weak' : 'swamped', calm: 0 };
      G.order(u, back.x, back.y, -1);
      u.prov = -1; u.mode = saved.mode === 'front' ? null : u.mode; u.falling = saved;
      return;
    }
    const f = u.falling;
    f.calm = u.foes ? 0 : f.calm + dt;
    const ready = f.why === 'weak' ? u.str >= B.returnAt : f.calm >= B.calm;
    if (!ready) return;
    u.falling = null;
    if (f.mode === 'front') { u.mode = 'front'; u.frontT = 0; }
    else if (f.holdIds.length) { u.holdIds = f.holdIds; u.prov = f.holdIds[0]; G.holdT = 0; }
    else G.order(u, f.x, f.y, -1);
  }

  // Hold-the-front mode: the unit keeps itself on the nearest stretch of front,
  // digs in there and leans on it at frontPush strength. dir (unit vector or
  // null) biases which part of the front it goes for.
  G.holdFront = function (units, dir) {
    for (const u of units) {
      if (u.mode !== 'front') { u.prevStance = u.stance; if (u.stance === 'attack' || u.stance === 'assault') u.stance = 'probe'; }
      u.mode = 'front'; u.falling = null; u.frontDir = dir; u.frontT = 0; u.avoid = new Set();
    }
  };

  // Who holds each province (by control at its rally point).
  G.updateProvOwners = function () {
    for (const p of G.provinces.values()) {
      let bk = -1, b = 0.5;
      for (let k = 0; k < NC; k++) { const v = G.ctlAt(k, p.x, p.y); if (v >= b) { b = v; bk = k; } }
      G.provOwner[p.id] = bk;
    }
  };
  // Enemy-side provinces of k's front: not ours, but touching one that is.
  G.frontProvinces = function (k) {
    const out = [];
    for (const p of G.provinces.values()) {
      if (G.provOwner[p.id] === k) continue;
      for (const a of p.adj) if (G.provOwner[a] === k) { out.push(p); break; }
    }
    return out;
  };

  // For the HUD: strength facing each neighbour, and undefended stretches.
  // A unit belongs to the front of the nearest province across the border
  // (within reach); weight = strength x what the unit type is worth.
  G.frontReport = function (k) {
    const reach = PS * 1.7, worth = u => u.str * G.UNIT_TYPES[u.type].cost;
    const fronts = new Map(), get = e => { if (!fronts.has(e)) fronts.set(e, { e, mine: 0, theirs: 0 }); return fronts.get(e); };
    const mineFront = G.frontProvinces(k), gaps = [];
    for (const p of mineFront) if (G.provOwner[p.id] >= 0) get(G.provOwner[p.id]);
    const nearest = (u, list) => { let b = null, bd = reach * reach; for (const p of list) { const d = (p.x - u.x) ** 2 + (p.y - u.y) ** 2; if (d < bd) { bd = d; b = p; } } return b; };
    const ours = [...G.provinces.values()].filter(p => G.provOwner[p.id] === k);
    for (const u of G.units) {
      if (u.k === k) { const p = nearest(u, mineFront); if (p && G.provOwner[p.id] >= 0) get(G.provOwner[p.id]).mine += worth(u); }
      else if (nearest(u, ours) && fronts.has(u.k)) fronts.get(u.k).theirs += worth(u);
    }
    // gap: one of our border provinces with enemies close and nobody of ours near
    for (const p of ours) {
      let border = false;
      for (const a of p.adj) if (G.provOwner[a] !== k && G.provOwner[a] >= 0) { border = true; break; }
      if (!border) continue;
      let foe = false, friend = false;
      for (const u of G.units) {
        const d = hyp(u.x - p.x, u.y - p.y);
        if (u.k === k) { if (d < PS * 1.1) friend = true; } else if (d < PS * 1.3) foe = true;
      }
      if (foe && !friend) gaps.push(p);
    }
    return { fronts: [...fronts.values()].filter(f => !G.dead[f.e]), gaps };
  };

  function frontThink(u) {
    // already leaning on an enemy province that is still enemy-held: stay put
    const cur = G.provinces.get(u.prov);
    // halted by the coast rather than by the border: that province can't be reached from here
    if (cur && u.hasTarget && u.stuck > 3) {
      const d = hyp(u.tx - u.x, u.ty - u.y) || 1;
      if (!G.landAt(u.x + (u.tx - u.x) / d * 16, u.y + (u.ty - u.y) / d * 16)) u.avoid.add(cur.id);
    }
    const claims = new Map();
    for (const o of G.units) if (o !== u && o.k === u.k && o.mode === 'front' && o.prov >= 0) claims.set(o.prov, (claims.get(o.prov) || 0) + 1);
    // threatened stretches pull harder: enemy units standing near a front province
    const threat = p => { let n = 0; for (const o of G.units) if (o.k !== u.k && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 < (PS * 1.2) ** 2) n++; return n; };
    let best = null, bs = Infinity;
    for (const p of G.frontProvinces(u.k)) {
      if (G.ctlAt(u.k, p.x, p.y) >= 0.5 || u.avoid.has(p.id)) continue;
      const dx = p.x - u.x, dy = p.y - u.y, d = hyp(dx, dy);
      // spread out (one unit per stretch first), go where the enemy is, mild loyalty to the current spot
      let sc = d + PS * 1.6 * (claims.get(p.id) || 0) - 70 * Math.min(3, threat(p)) - (p === cur ? 60 : 0);
      if (u.frontDir) sc -= 0.6 * (dx * u.frontDir.x + dy * u.frontDir.y);
      if (sc < bs) { bs = sc; best = p; }
    }
    const single = o => o.holdIds.length === 1 && o.holdIds[0] === best.id;
    if (best && u.move === 'straight') { if (u.prov !== best.id || !u.straight) marchStraight([u], best, true); }
    else if (best && !single(u)) { u.holdIds = [best.id]; u.prov = best.id; spreadOnProvinces(u.k, u.holdIds, G.units.filter(o => o.k === u.k && single(o))); }
  }

  // A starving unit gives up to whoever surrounds it; the captor is paid for the haul.
  function surrender(u) {
    let to = -1, bd = Infinity;
    for (const o of G.units) { if (o.k === u.k) continue; const d = (o.x - u.x) ** 2 + (o.y - u.y) ** 2; if (d < bd) { bd = d; to = o.k; } }
    const reward = Math.round(G.unitCost(u.k, u.type) * G.SUPPLY.reward);
    if (to >= 0) G.money[to] += reward;
    G.effects.push({ type: 'surrender', x: u.x, y: u.y, k: u.k, t: 0, life: 1.2 });
    G.events.push({ type: 'surrender', k: u.k, to, reward });
  }

  G.step = function (dt) {
    const units = G.units;
    G.time += dt;

    // --- AI + movement. Speed scales with own control just ahead, so a unit
    // advancing into enemy land sits on the front and pushes it forward.
    for (const u of units) {
      u.age += dt;
      if (!G.isHuman(u.k) && !u.falling && !G.aiPassive) { u.ai -= dt; if (u.ai <= 0) { u.ai = 3 + G.rnd() * 4; think(u); } }
      u.ahead = -1;
      u.ghostT = Math.max(0, (u.ghostT || 0) - dt); u.wasBumped = u.bumped;
      u.here = G.ctlAt(u.k, u.x, u.y) < 0.5 ? G.provAt(u.x, u.y) : -1;   // stranded: fight for the ground underfoot
      if (u.mode === 'front' && !u.falling && (u.frontT -= dt) <= 0) { u.frontT = 2.5; frontThink(u); }
      stepRetreat(u, dt);
      const st = G.STANCES[u.stance];
      u.tired = clamp(u.tired + (u.stance === 'assault' && (u.pushing || u.fighting) ? dt / 40 : -dt / 30), 0, 1);
      // dig in when idle - or when holding the front and no longer able to advance
      const still = u.sup > 0 && (!u.hasTarget || (u.mode === 'front' && u.stuck > 1));
      u.dig = still && st.dig ? Math.min(1, u.dig + st.dig * dt / T.digTime) : Math.max(0, u.dig - dt / 3);
      if (!u.hasTarget) continue;
      // follow the planned path; plan again when the way ahead stops being clear
      if (u.straight) u.path = [];   // no routing: straight at it
      else if (!u.path || (u.planT -= dt) <= 0) {
        const nextX = u.path && u.path.length ? u.path[0].x : u.tx, nextY = u.path && u.path.length ? u.path[0].y : u.ty;
        if (!u.path || !walkable(u.k, u.x, u.y, nextX, nextY)) replan(u); else u.planT = 1.2;
      }
      while (u.path.length && hyp(u.path[0].x - u.x, u.path[0].y - u.y) < 9) u.path.shift();
      const goalX = u.path.length ? u.path[0].x : u.tx, goalY = u.path.length ? u.path[0].y : u.ty;
      const dx = goalX - u.x, dy = goalY - u.y, dist = hyp(dx, dy);
      if (!u.path.length && dist < 3) { u.hasTarget = false; u.hx = u.hy = 0; continue; }
      if (dist < 0.5) continue;
      let nx = dx / dist, ny = dy / dist;
      const pa = Math.min(dist, T.pushAhead);
      u.ahead = G.provAt(u.x + nx * pa, u.y + ny * pa);
      const own = G.ctlAt(u.k, u.x + nx * T.lookahead, u.y + ny * T.lookahead);
      // slow in the combat zone, fast in the rear; worse when short of supply
      const pid = provIdAt(u.x, u.y), fd = pid >= 0 && G.provOwner[pid] === u.k ? G.frontDist[u.k][pid] : 0;
      const zone = G.SUPPLY.zone[fd < 0 ? 4 : Math.min(4, fd)] * G.SUPPLY.speed[u.sup];
      const step = Math.min(dist, zone * T.speed * G.COUNTRIES[u.k].speed * G.UNIT_TYPES[u.type].speed * T.terrSpeed[G.terrAt(u.x, u.y)] * (T.creep + (1 - T.creep) * smoothstep(0.45, 0.8, own)) * dt);
      // ease the heading round instead of snapping to it (exact on the final approach)
      if (dist > 14) {
        const e = 1 - Math.exp(-dt * 9);
        u.hx += (nx - u.hx) * e; u.hy += (ny - u.hy) * e;
        const hl = hyp(u.hx, u.hy);
        if (hl > 0.3) { nx = u.hx / hl; ny = u.hy / hl; }
      } else { u.hx = nx; u.hy = ny; }
      const ox = u.x, oy = u.y;
      tryMove(u, nx * step, ny * step);
      u.stuck = hyp(u.x - ox, u.y - oy) < 4 * dt ? (u.stuck || 0) + dt : 0;   // seconds spent halted (by the border - or by a friend)
      // The guarantee: bumping into friends and no real progress for a second (jostling
      // back and forth doesn't count as progress) -> pass through them for a moment.
      if (u.wasBumped) u.jostled = true;
      if ((u.progT = (u.progT || 0) + dt) >= 1) {
        if (u.jostled && u.lx !== undefined && hyp(u.x - u.lx, u.y - u.ly) < 7 && dist > 20) u.ghostT = 2.5;
        u.progT = 0; u.lx = u.x; u.ly = u.y; u.jostled = false;
      }
    }

    // --- guard aura
    for (const u of units) u.aura = false;
    for (const g of units) {
      if (g.type !== 'guard') continue;
      for (const u of units) if (u !== g && u.k === g.k && (u.x - g.x) ** 2 + (u.y - g.y) ** 2 < G.GUARD_AURA.range ** 2) u.aura = true;
    }

    // --- separation + combat
    G.clashes.length = 0;
    const pairs = [];
    for (const u of units) {
      u.fighting = false; u.foes = 0; u.friends = 0; u.hurt = 0; u.bumped = false;
      // provinces back from enemy ground: 1 = a border province, 2 = the one behind it, ... (9 = no front anywhere)
      const pid = provIdAt(u.x, u.y), fd = pid >= 0 && G.provOwner[pid] === u.k ? G.frontDist[u.k][pid] : 0;
      u.fd = fd < 0 ? 9 : fd;
    }
    for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      const a = units[i], b = units[j], enemy = a.k !== b.k;
      const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy) || 0.01;
      // Friendly units: solid at the front, where blocking matters; in the rear
      // (phaseFrom+ provinces back from enemy ground) they pass through one another,
      // and a unit that is falling back always does. Two settled units always shuffle apart.
      const settled = !a.hasTarget && !b.hasTarget;
      const ghost = !enemy && !settled && (a.falling || b.falling || a.ghostT > 0 || b.ghostT > 0 || (a.fd >= T.phaseFrom && b.fd >= T.phaseFrom));
      // a division on the move needs less elbow room than one settling into a line
      const min = enemy ? T.sepEnemy : settled ? T.sepFriend : T.sepMoving;
      if (d < min && !ghost) {
        if (enemy || settled) {
          const push = Math.min((min - d) * 0.5, (enemy ? 60 : 25) * dt), px = dx / d * push, py = dy / d * push;
          tryMove(a, -px, -py); tryMove(b, px, py);
        } else {
          // Friends, at least one moving: never push a mover straight back (two meeting
          // head-on would cancel each other out). Each mover sidesteps - away from the
          // other if it is off to one side, otherwise to its own right, so two units
          // coming at each other both give way in opposite directions. A settled unit
          // keeps its place.
          const push = Math.min((min - d) * 0.6 + 4 * dt, 70 * dt);
          for (const [m, ax, ay] of [[a, -dx / d, -dy / d], [b, dx / d, dy / d]]) {
            if (!m.hasTarget) continue;
            m.bumped = true;
            const hl = hyp(m.hx, m.hy), hx = hl > 0.2 ? m.hx / hl : -ay, hy = hl > 0.2 ? m.hy / hl : ax;
            const cross = hx * ay - hy * ax, side = Math.abs(cross) < 0.25 ? 1 : cross > 0 ? 1 : -1;
            tryMove(m, (-hy * side * 0.85 + ax * 0.35) * push * 1.6, (hx * side * 0.85 + ay * 0.35) * push * 1.6);
          }
        }
      }
      if (!enemy && d < T.fightRange) { a.friends++; b.friends++; }
      if (enemy && d < T.fightRange) {
        a.fighting = b.fighting = true;
        a.foes++; b.foes++; pairs.push(a, b);
        G.clashes.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, id: a.id * 131 + b.id });
      }
    }
    // damage taken: attacker strength and quality, against the defender's quality,
    // home ground + terrain, entrenchment, and how many enemies are on it at once
    const hit = (a, b) => {
      const home = G.ctlAt(a.k, a.x, a.y) > 0.5;
      a.hurt += T.damage * b.str * G.SUPPLY.dmg[b.sup] * G.COUNTRIES[b.k].atk * G.UNIT_TYPES[b.type].dmg / G.COUNTRIES[a.k].def * G.UNIT_TYPES[a.type].armor * (home ? 0.7 * T.terrArmor[G.terrAt(a.x, a.y)] : 1)
        * (1 - T.digArmor * a.dig) * (1 + T.flank * (a.foes - 1)) * G.STANCES[a.stance].hurt * (a.aura ? G.GUARD_AURA.hurt : 1) * dt;
    };
    for (let i = 0; i < pairs.length; i += 2) { hit(pairs[i], pairs[i + 1]); hit(pairs[i + 1], pairs[i]); }
    for (let i = units.length - 1; i >= 0; i--) {
      const u = units[i];
      u.str -= u.hurt + (u.sup === 0 ? G.SUPPLY.attrition * dt : 0);
      if (u.sup === 0 && u.str < G.SUPPLY.surrenderAt && u.str > 0.05) { surrender(u); units.splice(i, 1); }
      else if (u.str <= 0.05) { G.effects.push({ type: 'death', x: u.x, y: u.y, k: u.k, t: 0, life: 0.6 }); units.splice(i, 1); }
      else if (!u.fighting && u.sup === 2 && G.ctlAt(u.k, u.x, u.y) > 0.5) u.str = Math.min(1, u.str + T.regen * dt);
    }

    stepHold(dt);
    capture(dt);
    stepBuildings(dt);
    stepJets(dt);
    stepCapitals(dt);

    // --- economy: territory pays, armies cost; the AI spends as soon as it can
    if ((G.statT -= dt) <= 0) { G.statT = 0.5; G.computeStats(); G.updateProvOwners(); updateSupply(0.5); findPockets(); }
    fadePockets(dt);
    const count = new Float32Array(NC);   // army size in infantry-equivalents, for upkeep
    for (const u of units) count[u.k] += G.UNIT_TYPES[u.type].cost;
    for (const j of G.jets) count[j.k] += G.JET.upkeep;
    for (let k = 0; k < NC; k++) {
      if (G.dead[k]) { G.income[k] = 0; continue; }
      let cities = 0;
      for (let j = 0; j < NC; j++) if (j !== k && G.cityOwner(j) === k) cities++;
      G.income[k] = Math.max(0.5, T.baseIncome + T.shareIncome * G.stats.share[k] + T.cityIncome * cities - T.upkeep * G.COUNTRIES[k].cost * count[k]);
      G.money[k] += G.income[k] * dt;
      if (G.isHuman(k) || G.aiPassive) continue;
      aiSpend(k);
      // AI air marker: wherever one of its units is currently fighting
      if ((G.aiAir[k] -= dt) <= 0 && G.jets.some(j => j.k === k)) {
        G.aiAir[k] = 8;
        const f = units.filter(u => u.k === k && u.fighting), u = f[G.rnd() * f.length | 0];
        if (u) G.airMark[k] = { x: u.x, y: u.y };
      }
    }
  };

  function capture(dt) {
    const P = G.pressure, ctl = G.ctl, R = T.capR;
    const touched = [], touchedFlag = G.touchedFlag || (G.touchedFlag = new Uint8Array(N));
    const stack = new Map();   // units pushing the same province reinforce each other
    for (const u of G.units) if (u.prov >= 0) { const key = u.k * 100000 + u.prov; stack.set(key, (stack.get(key) || 0) + 1); }
    for (const u of G.units) {
      const cx = u.x / CELL - 0.5, cy = u.y / CELL - 0.5, w = 0.35 + 0.65 * u.str, C = G.COUNTRIES[u.k], ty = G.UNIT_TYPES[u.type];
      const st = G.STANCES[u.stance], stPush = u.falling ? 0 : u.stance === 'assault' ? st.push - 0.8 * u.tired : st.push;
      const stackMul = Math.min(2, 1 + T.stack * ((stack.get(u.k * 100000 + u.prov) || 1) - 1));
      let pushed = false;
      const atkW = G.SUPPLY.push[u.sup] * stPush * C.atk * ty.atk * Math.min(2, 1 + T.stack * ((stack.get(u.k * 100000 + u.prov) || 1) - 1));
      const pv = u.prov, ah = u.ahead, he = u.here, hold = u.holdIds, multi = hold.length > 1;   // hoisted out of the cell loop
      const defW = G.SUPPLY.hold[u.sup] * st.hold * (u.aura ? G.GUARD_AURA.hold : 1) * T.defBonus * C.def * ty.def * (1 + T.digDef * u.dig);
      const ax = Math.max(0, Math.floor(cx - R)), bx = Math.min(GW - 1, Math.ceil(cx + R));
      const ay = Math.max(0, Math.floor(cy - R)), by = Math.min(GH - 1, Math.ceil(cy + R));
      for (let iy = ay; iy <= by; iy++) for (let ix = ax; ix <= bx; ix++) {
        const q = ((ix - cx) / R) ** 2 + ((iy - cy) / R) ** 2;
        if (q >= 1) continue;
        // Ground is only taken in the province the unit was ordered into or is
        // moving into; anywhere else its pressure just defends what is held.
        const i = iy * GW + ix, id = G.cellProv[i];
        const terr = id < 0 ? 0 : G.provTerr[id];
        const m = ctl[i * NC + u.k] >= 0.5 ? defW * T.terrDef[terr] : id === pv || id === ah || id === he || (multi && hold.includes(id)) ? atkW * T.terrAtk[terr] : 0;
        if (m && ctl[i * NC + u.k] < 0.5) pushed = true;
        if (m) { P[i * NC + u.k] += w * m * (1 - q) * (1 - q); if (!touchedFlag[i]) { touchedFlag[i] = 1; touched.push(i); } }
      }
      // what the flag badge shows: pushing with a bonus (1) or at a penalty (-1), or holding with a bonus (2)
      const atkB = stackMul * T.terrAtk[u.prov >= 0 ? G.provTerr[u.prov] : 0] * (u.stance === 'assault' ? stPush : 1);
      const defB = (1 + T.digDef * u.dig) * T.terrDef[G.terrAt(u.x, u.y)] * st.hold * (u.aura ? G.GUARD_AURA.hold : 1);
      u.pushing = pushed;
      u.bonus = pushed ? (atkB > 1.05 ? 1 : atkB < 0.95 ? -1 : 0) : defB > 1.15 ? 2 : 0;
      u.bonusAmt = pushed ? atkB : defB;
    }
    for (const cell of touched) {
      const o = cell * NC;
      let b = 0, s = 0, bk = -1;
      for (let k = 0; k < NC; k++) { const p = P[o + k]; if (p > b) { s = b; b = p; bk = k; } else if (p > s) s = p; }
      const net = b - s;
      if (bk < 0 || net < 0.002) continue;
      const others = 1 - ctl[o + bk];
      if (others < 1e-5) continue;
      const delta = Math.min(T.capRate * net * dt, others), scale = (others - delta) / others;
      for (let k = 0; k < NC; k++) if (k !== bk) ctl[o + k] *= scale;
      ctl[o + bk] += delta;
    }
    for (const cell of touched) { touchedFlag[cell] = 0; const o = cell * NC; P[o] = P[o + 1] = P[o + 2] = P[o + 3] = 0; }
  }

  // Pockets: a connected patch of one country's land whose only neighbour is a
  // single other country (sea does not count as a way out). It fades into the
  // surrounding country. Never a pocket: a country's largest body, the body
  // holding its capital, or a patch still garrisoned by its own units.
  function findPockets() {
    const ctl = G.ctl, land = G.land, owner = new Int8Array(N).fill(-1), comp = new Int32Array(N).fill(-1);
    for (let i = 0; i < N; i++) {
      if (land[i] <= 0.5) continue;
      let bk = 0, b = -1;
      for (let k = 0; k < NC; k++) if (ctl[i * NC + k] > b) { b = ctl[i * NC + k]; bk = k; }
      owner[i] = bk;
    }
    const comps = [], stack = [];
    for (let i = 0; i < N; i++) {
      if (owner[i] < 0 || comp[i] >= 0) continue;
      const c = { k: owner[i], cells: [], mask: 0, keep: false };
      comp[i] = comps.length; stack.push(i);
      while (stack.length) {
        const j = stack.pop(), x = j % GW, y = j / GW | 0;
        c.cells.push(j);
        for (let d = 0; d < 4; d++) {
          const ax = x + (d === 0) - (d === 1), ay = y + (d === 2) - (d === 3);
          if (ax < 0 || ay < 0 || ax >= GW || ay >= GH) continue;
          const n = ay * GW + ax;
          if (owner[n] < 0) continue;
          if (owner[n] !== c.k) c.mask |= 1 << owner[n];
          else if (comp[n] < 0) { comp[n] = comps.length; stack.push(n); }
        }
      }
      comps.push(c);
    }
    const cellOf = (x, y) => clamp(y / CELL | 0, 0, GH - 1) * GW + clamp(x / CELL | 0, 0, GW - 1);
    const largest = new Array(NC).fill(null);
    for (const c of comps) if (!largest[c.k] || c.cells.length > largest[c.k].cells.length) largest[c.k] = c;
    for (const c of largest) if (c) c.keep = true;
    G.caps.forEach((p, k) => { const c = comps[comp[cellOf(p.x, p.y)]]; if (c && c.k === k) c.keep = true; });
    for (const u of G.units) { const c = comps[comp[cellOf(u.x, u.y)]]; if (c && c.k === u.k) c.keep = true; }

    const cells = [], to = [];
    for (const c of comps) {
      if (c.keep || !c.mask || (c.mask & (c.mask - 1))) continue;   // needs exactly one neighbouring country
      const k = Math.log2(c.mask) | 0;
      for (const i of c.cells) { cells.push(i); to.push(k); }
    }
    G.pocketCells = cells; G.pocketTo = to;
  }

  function fadePockets(dt) {
    const ctl = G.ctl, cells = G.pocketCells, to = G.pocketTo;
    for (let n = 0; n < cells.length; n++) {
      const o = cells[n] * NC, k = to[n], others = 1 - ctl[o + k];
      if (others < 1e-5) continue;
      const delta = Math.min(T.pocketFade * dt, others), scale = (others - delta) / others;
      for (let j = 0; j < NC; j++) if (j !== k) ctl[o + j] *= scale;
      ctl[o + k] += delta;
    }
  }

  G.packCtl = function () {
    const ctl = G.ctl, tex = G.ctlTex;
    for (let i = 0; i < tex.length; i++) tex[i] = ctl[i] * 255 + 0.5 | 0;
    return tex;
  };

  G.computeStats = function () {
    const s = G.stats, ctl = G.ctl, land = G.land;
    s.area.fill(0); s.cx.fill(0); s.cy.fill(0);
    let total = 0;
    for (let i = 0; i < N; i++) {
      if (land[i] <= 0.5) continue;
      let bk = 0, b = -1;
      for (let k = 0; k < NC; k++) if (ctl[i * NC + k] > b) { b = ctl[i * NC + k]; bk = k; }
      s.area[bk]++; s.cx[bk] += i % GW; s.cy[bk] += i / GW | 0; total++;
    }
    for (let k = 0; k < NC; k++) {
      if (s.area[k] > 0) { s.cx[k] = (s.cx[k] / s.area[k] + 0.5) * CELL; s.cy[k] = (s.cy[k] / s.area[k] + 0.5) * CELL; }
      s.share[k] = s.area[k] / total;
    }
  };
})();
