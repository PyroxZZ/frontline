'use strict';
// Camera, input, HUD and the frame loop.
(function () {
  const G = window.G, R = window.R;
  const { WORLD_W, WORLD_H, clamp, lerp } = G;
  const $ = id => document.getElementById(id);
  const overlay = $('overlay');

  const REC = { every: 2, next: 0, frames: [] };
  function record() {
    if (G.time < REC.next) return;
    REC.next = G.time + REC.every;
    const own = new Uint8Array(G.N + 3 >> 2), ctl = G.ctl;   // 4 countries = 2 bits a cell, four cells to the byte
    for (let i = 0, o = 0; i < G.N; i++, o += 4) { let b = ctl[o], k = 0; if (ctl[o + 1] > b) { b = ctl[o + 1]; k = 1; } if (ctl[o + 2] > b) { b = ctl[o + 2]; k = 2; } if (ctl[o + 3] > b) k = 3; own[i >> 2] |= k << (i & 3) * 2; }
    REC.frames.push({ t: G.time, own, units: G.units.map(u => [u.id, u.k, u.x, u.y, u.type]) });
    if (REC.frames.length > 900) { REC.frames = REC.frames.filter((_, i) => i % 2 === 0); REC.every *= 2; }   // very long war: thin it out
  }

  try {
    G.init(+new URLSearchParams(location.search).get('seed') || 20260918);
    // ?warm=N fast-forwards N seconds before the first frame (for screenshots/tests)
    const warm = +new URLSearchParams(location.search).get('warm') || 0;
    if (warm) { G.player = -1; for (let i = 0; i < warm * 60; i++) { G.step(1 / 60); record(); } G.effects.length = 0; G.events = G.events.filter(e => e.type === 'capitulate'); G.computeStats(); }
    R.init($('map'), overlay);
  } catch (err) {
    $('fatal').hidden = false; $('fatal').textContent = err.message;
    throw err;
  }

  // ---------- camera (cam eases toward goal, so pan/zoom never snaps)
  const fit = () => Math.min(window.innerWidth / WORLD_W, window.innerHeight / WORLD_H);
  const cam = { x: WORLD_W / 2, y: WORLD_H / 2, zoom: fit() * 1.1 };
  const goal = { ...cam };
  const keys = new Set();

  function updateCamera(dt) {
    const pan = 750 / goal.zoom * dt;
    if (keys.has('a') || keys.has('arrowleft')) goal.x -= pan;
    if (keys.has('d') || keys.has('arrowright')) goal.x += pan;
    if (keys.has('w') || keys.has('arrowup')) goal.y -= pan;
    if (keys.has('s') || keys.has('arrowdown')) goal.y += pan;
    goal.x = clamp(goal.x, 0, WORLD_W); goal.y = clamp(goal.y, 0, WORLD_H);
    const k = 1 - Math.exp(-dt * 14);
    cam.x = lerp(cam.x, goal.x, k); cam.y = lerp(cam.y, goal.y, k); cam.zoom = lerp(cam.zoom, goal.zoom, k);
  }

  const toWorld = (c, sx, sy) => ({ x: c.x + (sx - window.innerWidth / 2) / c.zoom, y: c.y + (sy - window.innerHeight / 2) / c.zoom });
  const toScreen = (x, y) => ({ x: (x - cam.x) * cam.zoom + window.innerWidth / 2, y: (y - cam.y) * cam.zoom + window.innerHeight / 2 });

  overlay.addEventListener('wheel', e => {
    e.preventDefault();
    const before = toWorld(goal, e.clientX, e.clientY);
    goal.zoom = clamp(goal.zoom * Math.exp(-e.deltaY * 0.0015), fit() * 0.85, 4);
    const after = toWorld(goal, e.clientX, e.clientY);
    goal.x += before.x - after.x; goal.y += before.y - after.y;
  }, { passive: false });

  // ---------- commands: the UI never changes the simulation directly. It issues
  // commands; alone they run at the next tick, in a network game they go through
  // the lockstep so every machine applies them at the same tick.
  let lockstep = null;
  const localQueue = [];
  const issue = cmd => { if (tut) tut.onCmd(cmd); if (lockstep) lockstep.issue(cmd); else localQueue.push(cmd); };
  const idsOf = units => units.map(u => u.id);
  function onExec(k, cmd, r) {
    if (k !== G.player) return;
    if (r && r.x !== undefined && cmd.t !== 'jet') G.effects.push({ type: 'ping', x: r.x, y: r.y, t: 0, life: 0.5 });
    if (cmd.t === 'jet' && r && !G.airMark[k]) ui.build = 'airmark';   // a first jet with nowhere to go: ask for the marker
  }

  // ---------- selection + orders
  const ui = { cam, time: 0, dt: 0, hover: null, hoverProv: null, hoverB: null, flash: null, box: null, order: null, build: null, mouse: null };
  let drag = null;
  const selected = () => G.units.filter(u => u.sel);

  function unitAt(sx, sy) {
    const s = R.unitScale(cam), hw = R.FLAG_W / 2 * s + 4, hh = R.FLAG_H / 2 * s + 4;
    let best = null, bd = Infinity;
    for (const u of G.units) {
      if (u.k !== G.player) continue;
      const p = toScreen(u.x, u.y), dx = Math.abs(p.x - sx), dy = Math.abs(p.y - sy);
      if (dx <= hw && dy <= hh && dx + dy < bd) { bd = dx + dy; best = u; }
    }
    return best;
  }

  // Slots for an order: along the drawn line a->b, or (for a plain click) a
  // line through the point, perpendicular to the direction of travel.
  function orderSlots(units, a, b) {
    const n = units.length;
    if (!n) return [];
    if (Math.hypot(b.x - a.x, b.y - a.y) * cam.zoom < 18) {
      if (n === 1) return [{ x: b.x, y: b.y }];
      let cx = 0, cy = 0;
      for (const u of units) { cx += u.x / n; cy += u.y / n; }
      const dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy) || 1, half = (n - 1) * 16;
      a = { x: b.x + dy / d * half, y: b.y - dx / d * half };
      b = { x: b.x - dy / d * half, y: b.y + dx / d * half };
    }
    const slots = [];
    for (let i = 0; i < n; i++) { const t = n === 1 ? 0.5 : i / (n - 1); slots.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }); }
    return slots;
  }

  function issueOrder(a, b) {
    const units = selected(), slots = orderSlots(units, a, b);
    if (!slots.length) return;
    // match units to slots in order along the line so paths don't cross
    const first = slots[0], last = slots[slots.length - 1];
    const lx = last.x - first.x, ly = last.y - first.y;
    units.sort((p, q) => (p.x * lx + p.y * ly) - (q.x * lx + q.y * ly));
    issue({ t: 'line', slots: units.map((u, i) => ({ id: u.id, x: slots[i].x, y: slots[i].y })) });
    for (const s of slots) G.effects.push({ type: 'ping', x: s.x, y: s.y, t: 0, life: 0.5 });
  }

  function buildingAt(sx, sy) {
    for (const b of G.buildings) {
      if (b.k !== G.player) continue;
      const p = toScreen(b.x, b.y);
      if (Math.hypot(p.x - sx, p.y - sy) < 13) return b;
    }
    return null;
  }

  // X: selected units (or the whole army when nothing is selected) go and hold
  // the front, leaning toward the cursor.
  function holdFront() {
    let units = selected();
    if (!units.length) units = G.units.filter(u => u.k === G.player);
    if (!units.length) return;
    let dir = null;
    if (ui.mouse) {
      let cx = 0, cy = 0;
      for (const u of units) { cx += u.x / units.length; cy += u.y / units.length; }
      const dx = ui.mouse.x - cx, dy = ui.mouse.y - cy, d = Math.hypot(dx, dy);
      if (d > 40) dir = { x: dx / d, y: dy / d };
    }
    issue({ t: 'front', ids: idsOf(units), dir });
    for (const u of units) G.effects.push({ type: 'ping', x: u.x, y: u.y, t: 0, life: 0.5 });
  }

  function provinceAtScreen(sx, sy) {
    const w = toWorld(cam, sx, sy);
    return G.landAt(w.x, w.y) ? G.provinces.get(G.provAt(w.x, w.y)) || null : null;
  }

  // Advance the selection into a province (shift: add it to the current order): the sim spreads the units along the
  // province's edges that face the enemy (or round its middle if none do).
  function orderProvince(p, add) {
    const units = selected();
    if (!units.length) return false;
    issue({ t: ui.guardMode ? 'guard' : 'hold', ids: idsOf(units), p: p.id, add: !!add });
    ui.guardMode = false;
    ui.flash = { p, t: 0 };
    return true;
  }

  // X: guard the province under the cursor - the same move as an attack click, but
  // the divisions arrive in Hold stance. From the card button (cursor not on the
  // map) it arms the next province click instead. With nothing selected, X is
  // still "whole army: hold the front".
  function guardKey(shift) {
    if (!selected().length) return holdFront();
    const p = pointer && provinceAtScreen(pointer.x, pointer.y);
    ui.guardMode = true;
    if (p) orderProvince(p, shift);
  }

  overlay.addEventListener('contextmenu', e => e.preventDefault());

  overlay.addEventListener('pointerdown', e => {
    if (attract) return;
    if (replay && e.button !== 1) return;   // timelapse: look, don't touch (middle-drag still pans)
    if (ui.build) {   // placing a building: left places (shift keeps placing), right cancels
      if (e.button === 0 && ui.build === 'airmark') {
        const w = toWorld(cam, e.clientX, e.clientY);
        issue({ t: 'airmark', x: w.x, y: w.y });
        ui.build = null;
      } else if (e.button === 0) {
        const w = toWorld(cam, e.clientX, e.clientY);
        if (G.canBuild(G.player, w.x, w.y) && G.money[G.player] >= G.BUILDINGS[ui.build].cost) { issue({ t: 'build', type: ui.build, x: w.x, y: w.y }); if (!e.shiftKey) ui.build = null; }
      } else ui.build = null;
      updateEcon();
      return;
    }
    overlay.setPointerCapture(e.pointerId);
    if (e.button === 0) drag = { type: 'box', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    else if (e.button === 2) { const w = toWorld(cam, e.clientX, e.clientY); drag = { type: 'order', a: w, b: w, sx: e.clientX, sy: e.clientY }; }
    else if (e.button === 1) { e.preventDefault(); drag = { type: 'pan', sx: e.clientX, sy: e.clientY, gx: goal.x, gy: goal.y }; }
  });

  let pointer = null, hoverStale = false, cursorNow = '';
  function resolveHover() {   // once per frame, from the last mouse position
    if (!pointer || (!hoverStale && !drag)) return;
    hoverStale = false;
    const x = pointer.x, y = pointer.y;
    ui.hover = drag || replay ? null : unitAt(x, y);
    ui.mouse = toWorld(cam, x, y);
    ui.hoverB = drag || replay || ui.hover || ui.build ? null : buildingAt(x, y);
    ui.hoverProv = drag || replay || ui.hover || ui.hoverB || ui.build ? null : provinceAtScreen(x, y);
    const cur = drag && drag.type === 'pan' ? 'grabbing' : ui.build || ui.guardMode ? 'crosshair' : ui.hover || ui.hoverB ? 'pointer' : 'default';
    if (cur !== cursorNow) overlay.style.cursor = cursorNow = cur;
  }
  overlay.addEventListener('pointermove', e => {
    pointer = { x: e.clientX, y: e.clientY }; hoverStale = true;
    if (!drag) return;
    if (drag.type === 'box') { drag.x1 = e.clientX; drag.y1 = e.clientY; }
    else if (drag.type === 'order') drag.b = toWorld(cam, e.clientX, e.clientY);
    else { goal.x = drag.gx - (e.clientX - drag.sx) / goal.zoom; goal.y = drag.gy - (e.clientY - drag.sy) / goal.zoom; }
  });

  overlay.addEventListener('pointerup', e => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.type === 'order') {
      // right-click: advance into the province; right-drag: hold the drawn line
      const p = Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 18 && provinceAtScreen(e.clientX, e.clientY);
      if (p) orderProvince(p, e.shiftKey); else issueOrder(d.a, d.b);
    }
    if (d.type !== 'box') return;
    const click = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 5, clicked = click && unitAt(d.x1, d.y1);
    // left-click on your barracks / capital = new divisions muster there
    if (click && !clicked) {
      const b = buildingAt(d.x1, d.y1);
      // any capital you hold (your own or a captured one) can be the muster point
      let city = -1;
      if (!b) G.caps.forEach((c, j) => { const q = toScreen(c.x, c.y); if (G.cityOwner(j) === G.player && Math.hypot(q.x - d.x1, q.y - d.y1) < 11) city = j; });
      const already = city >= 0 && (city === G.player ? !G.muster[G.player] : G.muster[G.player] && G.muster[G.player].cap === city);
      if ((b && b.type === 'barracks') || (city >= 0 && !already)) {
        issue(b ? { t: 'muster', id: b.id } : { t: 'muster', id: null, cap: city });
        const at = b || G.caps[city];
        G.effects.push({ type: 'ping', x: at.x, y: at.y, t: 0, life: 0.5 });
        return;
      }
      if (b) return;
    }
    // left-click on a province with troops selected = advance (selection kept)
    if (click && !clicked) { const p = provinceAtScreen(d.x1, d.y1); if (p && orderProvince(p, e.shiftKey)) return; }
    if (!e.shiftKey) for (const u of G.units) u.sel = false;
    if (click) {
      if (clicked) clicked.sel = true;
    } else {
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      for (const u of G.units) {
        if (u.k !== G.player) continue;
        const p = toScreen(u.x, u.y);
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) u.sel = true;
      }
    }
    updateSelPanel();
  });

  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    if (attract || e.target.tagName === 'INPUT') return;   // home page / typing a room code
    if (k === 'tab') e.preventDefault();
    if (replay) { if (k === 'escape' || k === 'l') stopReplay(); else if (k === ' ') { e.preventDefault(); $('replay-play').click(); } return; }
    if (k === 'l') { if (!lockstep || ended) startReplay(); return; }   // (it pauses the game, so not during a network game)
    if (!e.ctrlKey && cardKey(k)) return;
    if (e.ctrlKey && k === 'a') { e.preventDefault(); for (const u of G.units) u.sel = u.k === G.player; updateSelPanel(); return; }
    if (k === ' ') { e.preventDefault(); setSpeed(speed ? 0 : lastSpeed); }
    else if (k === '1') setSpeed(1);
    else if (k === '2') setSpeed(2);
    else if (k === '3') setSpeed(4);
    else if (k === 'escape' && (ui.build || ui.guardMode)) { ui.build = null; ui.guardMode = false; updateEcon(); }
    else if (k === 'escape') { for (const u of G.units) u.sel = false; updateSelPanel(); }
    else keys.add(k);
  });
  window.addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());
  window.addEventListener('resize', () => { R.resize(); goal.zoom = Math.max(goal.zoom, fit() * 0.85); });

  // ---------- HUD
  const flagCss = f => {
    const n = f.stripes.length;
    return `linear-gradient(${f.dir === 'v' ? 90 : 180}deg, ${f.stripes.map((c, i) => `${c} ${i * 100 / n}% ${(i + 1) * 100 / n}%`).join(', ')})`;
  };

  const chips = G.COUNTRIES.map((c, k) => {
    const el = document.createElement('div');
    el.className = 'chip';
    el.innerHTML = `<span class="flag"></span><span class="name"></span><span class="trait"></span><span class="you">YOU</span><span class="pct"></span><span class="share"></span>`;
    el.querySelector('.flag').style.background = flagCss(c.flag);
    el.querySelector('.name').textContent = c.name;
    el.querySelector('.trait').textContent = c.trait;
    el.title = `${c.trait}: attack x${c.atk}, defence x${c.def}, speed x${c.speed}, division cost ${c.cost}`;
    el.querySelector('.share').style.background = c.color;
    el.addEventListener('click', () => setPlayer(k));
    $('countries').appendChild(el);
    return el;
  });

  function setPlayer(k, force) {
    if (G.dead[k] || (lockstep && !force)) return;   // in a network game your seat is fixed
    G.player = k;
    for (const u of G.units) { u.sel = false; if (u.k === k) { u.hasTarget = false; u.prov = -1; } }
    ui.build = null;
    chips.forEach((el, i) => el.classList.toggle('player', i === k));
    goal.x = G.caps[k].x; goal.y = G.caps[k].y;
    updateSelPanel();
  }

  // ---------- command card (bottom-left, AoE-style): a grid of icon buttons with
  // the hotkey in the corner. Contextual - production and buildings when nothing
  // is selected, unit orders when divisions are. Keys follow the keyboard rows,
  // skipping WASD (camera): Q E R T / F G H J / Z X C V.
  const ICON = {
    infantry: '<circle cx="12" cy="7" r="3"/><path d="M6 21v-6a6 6 0 0 1 12 0v6z"/>',
    guard: '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"/><path d="M12 7l1.5 3 3.3.4-2.4 2.3.6 3.3-3-1.6-3 1.6.6-3.3-2.400-2.300 3.300-.4z" fill="#10161e"/>',
    artillery: '<circle cx="8" cy="17" r="4"/><path d="M7 14L19 4l2 2.500L10 17z"/>',
    barracks: '<path d="M2 12L12 3l10 9h-3v9H5v-9z"/><rect x="10" y="14" width="4" height="7" fill="#10161e"/>',
    jet: '<path d="M22 12L9 8 6 3H4l2 7-4 2 4 2-2 7h2l3-5z"/>',
    target: '<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v6M12 16v6M2 12h6M16 12h6" stroke="currentColor" stroke-width="2"/>',
    autofront: '<path d="M3 5h8v14H3z" opacity=".5"/><path d="M12 9h5V5l5 7-5 7v-4h-5z"/>',
    front: '<path d="M4 3h3v18H4zM10.500 3h3v18h-3zM17 3h3v18h-3z"/>',
    supply: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3 8l9 5 9-5M12 13v8" stroke="currentColor" stroke-width="2" fill="none"/>',
    hold: '<path d="M12 2l8 3v6c0 5-3.500 8.500-8 11-4.500-2.500-8-6-8-11V5z"/>',
    probe: '<path d="M3 11h10V6l8 6-8 6v-5H3z" opacity=".55"/>',
    attack: '<path d="M3 10h10V5l9 7-9 7v-5H3z"/>',
    assault: '<path d="M2 10h7V6l7 6-7 6v-4H2z"/><path d="M13 6l7 6-7 6h3l7-6-7-6z"/>',
    never: '<path d="M5 3h3v18H5z"/><path d="M8 4h11l-3 4 3 4H8z"/>',
    weak: '<path d="M21 13H11v5l-8-6 8-6v5h10z"/><rect x="15" y="16" width="7" height="3" opacity=".5"/>',
    outnumbered: '<path d="M21 13H11v5l-8-6 8-6v5h10z"/><circle cx="16" cy="5" r="2"/><circle cx="21" cy="5" r="2"/>',
    exploit: '<path d="M2 12h9M9 7l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2.500"/><path d="M14 7l6 5-6 5" fill="none" stroke="currentColor" stroke-width="2.500"/>',
    mass: '<circle cx="12" cy="12" r="3.500"/><path d="M3 3l5 5M21 3l-5 5M3 21l5-5M21 21l-5-5" stroke="currentColor" stroke-width="2.500"/>',
    straight: '<path d="M12 2l6 7h-4v13h-4V9H6z"/>',
    stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  };
  const me = () => G.player, sel = () => selected();
  const ping = u => { if (u) G.effects.push({ type: 'ping', x: u.x, y: u.y, t: 0, life: 0.5 }); };
  const setAll = (key, val) => issue({ t: 'set', ids: idsOf(sel()), key, val });
  const allAre = (key, val) => sel().length > 0 && sel().every(u => u[key] === val);
  const toggleAll = (key, on, off) => setAll(key, allAre(key, on) ? off : on);
  const unitBtn = (id, key, row) => ({ icon: id, key, name: G.UNIT_TYPES[id].name, row, cost: () => G.unitCost(me(), id), enabled: () => G.canRecruit(me(), id), run: () => issue({ t: 'recruit', type: id }),
    desc: id === 'guard' ? 'Very tough, weak attack. Friendly units beside a guard hold 35% harder and take 20% less damage.' : 'The standard division. Appears at your muster point.' });
  const buildBtn = (id, key, desc) => ({ icon: id, key, name: G.BUILDINGS[id].name, cost: () => G.BUILDINGS[id].cost, enabled: () => G.money[me()] >= G.BUILDINGS[id].cost, active: () => ui.build === id, run: () => { ui.build = ui.build === id ? null : id; }, desc });
  const stanceBtn = (id, key, desc) => ({ icon: id, key, name: G.STANCES[id].name, active: () => allAre('stance', id), run: () => setAll('stance', id), desc });
  const backBtn = (id, icon, key, name, desc) => ({ icon, key, name, active: () => allAre('retreat', id), run: () => setAll('retreat', id), desc });

  const CARDS = {
    base: [
      unitBtn('infantry', 'q'), unitBtn('guard', 'e'),
      buildBtn('artillery', 'r', 'Place on land you firmly hold. Shells flip small circles of enemy ground next to the border and hurt units in the blast.'),
      buildBtn('barracks', 't', 'A muster point and supply source. Click it (or your capital) to choose where new divisions appear.'),
      { icon: 'jet', key: 'f', name: 'Jet', cost: () => G.JET.cost, enabled: () => G.canBuyJet(me()), run: () => issue({ t: 'jet' }), desc: 'Based at the capital. Flies to the air target, rockets enemy ground near your border there, then returns to rearm.' },
      { icon: 'target', key: 'g', name: 'Air target', note: () => { const n = G.jets.filter(j => j.k === me()).length; return n ? n + (n > 1 ? ' jets' : ' jet') : ''; }, enabled: () => G.jets.some(j => j.k === me()), active: () => ui.build === 'airmark', run: () => { ui.build = ui.build === 'airmark' ? null : 'airmark'; }, desc: 'Choose the area your jets operate around.' },
      { icon: 'autofront', key: 'h', name: 'Recruits to the front', active: () => G.autoFront[me()], run: () => issue({ t: 'autofront', on: !G.autoFront[me()] }), desc: 'When on, every new division walks straight to the stretch of front that needs it most.' },
      null,
      { icon: 'front', key: 'x', name: 'Whole army: hold the front', run: () => holdFront(), desc: 'Every division goes to the front, spreads out, digs in and only probes. Leans toward the cursor.' },
      { icon: 'supply', key: 'tab', name: 'Supply map', active: () => ui.showSupply, run: () => { ui.showSupply = !ui.showSupply; updateFronts(true); }, desc: 'Routes back to your capital and barracks, supply level per province, and chokepoints.' },
    ],
    units: [
      stanceBtn('hold', 'q', 'Never push. Digs in twice as fast, holds 25% harder, takes 10% less damage.'),
      stanceBtn('probe', 'e', 'Push at 25% strength and keep digging in.'),
      stanceBtn('attack', 'r', 'Normal push.'),
      stanceBtn('assault', 't', 'Push 50% harder, take 50% more damage, no digging in. Tires after ~40s of fighting.'),
      backBtn('stand', 'never', 'f', 'Never fall back', 'Stand and fight to the end.'),
      backBtn('low', 'weak', 'g', 'Fall back when weak', 'Below 40% strength in combat: withdraw one province toward supply, recover to 70%, then return.'),
      backBtn('outnumbered', 'outnumbered', 'h', 'Fall back if outnumbered', 'Facing twice its numbers: give ground, return once things are calm.'),
      { icon: 'stop', key: 'j', name: 'Stop', run: () => issue({ t: 'stop', ids: idsOf(sel()) }), desc: 'Drop all orders and stay put.' },
      { icon: 'exploit', key: 'z', name: 'Exploit', active: () => allAre('pursuit', 'exploit'), run: () => toggleAll('pursuit', 'exploit', 'line'), desc: 'After taking what was ordered, keep rolling into undefended neighbouring provinces while fully supplied. Off: stop on the far edge.' },
      { icon: 'hold', key: 'x', name: 'Guard a province', active: () => !!ui.guardMode || (sel().length > 0 && sel().every(u => u.guard)), run: shift => guardKey(shift), desc: 'Point at a province and press X (or click this, then the province): the divisions move there like an attack, but in Hold stance - they line its enemy-facing edge, dig in and do not push. Shift adds provinces. A normal attack click puts them back on their old stance.' },
      { icon: 'mass', key: 'c', name: 'Concentrate', active: () => allAre('focus', 'mass'), run: () => toggleAll('focus', 'mass', 'spread'), desc: 'Mass on the weakest point of the edge for the stacking bonus. Off: spread evenly along it.' },
      { icon: 'straight', key: 'v', name: 'Straight in', active: () => allAre('move', 'straight'), run: () => issue({ t: 'move', ids: idsOf(sel()), val: allAre('move', 'straight') ? 'edge' : 'straight' }), desc: 'Province orders march straight at the target in formation and push whatever is in the way. Off: units line up along the enemy-facing edge.' },
    ],
  };
  let cardName = '', cardButtons = [];
  function buildCard(name) {
    cardName = name; cardButtons = [];
    const root = $('card'); root.innerHTML = '';
    for (const item of CARDS[name]) {
      const el = document.createElement(item ? 'button' : 'span');
      el.className = item ? 'cbtn' : 'cgap';
      if (item) {
        el.innerHTML = `<kbd>${item.key === 'tab' ? 'Tab' : item.key.toUpperCase()}</kbd><svg viewBox="0 0 24 24" fill="currentColor">${ICON[item.icon]}</svg><i></i>`;
        el.addEventListener('click', () => { pointer = null; if (!item.enabled || item.enabled()) item.run(false); refreshCard(); updateSelPanel(); });
        el.addEventListener('mouseenter', () => { $('card-tip').innerHTML = `<b>${item.name}</b>${item.cost ? ` &nbsp;<span class="cost">${item.cost()}</span>` : ''}<br>${item.desc}`; $('card-tip').hidden = false; });
        el.addEventListener('mouseleave', () => { $('card-tip').hidden = true; });
        cardButtons.push({ el, item });
      }
      root.appendChild(el);
    }
    $('card-title').textContent = name === 'units' ? 'Orders' : 'Command';
  }
  function refreshCard() {
    const want = sel().length ? 'units' : 'base';
    if (want !== cardName) buildCard(want);
    for (const { el, item } of cardButtons) {
      const state = (item.enabled && !item.enabled() ? 'o' : '') + (item.active && item.active() ? 'a' : '') + '|' + (item.cost ? item.cost() : item.note ? item.note() : '');
      if (state === el._state) continue;
      el._state = state;
      el.classList.toggle('off', state[0] === 'o');
      el.classList.toggle('active', state.split('|')[0].includes('a'));
      el.querySelector('i').textContent = state.slice(state.indexOf('|') + 1);
    }
  }
  let shiftDown = false;
  window.addEventListener('keydown', e => { shiftDown = e.shiftKey; }, true);
  function cardKey(k) {
    const hit = cardButtons.find(b => b.item.key === k);
    if (!hit) return false;
    if (!hit.item.enabled || hit.item.enabled()) hit.item.run(shiftDown);
    refreshCard(); updateSelPanel();
    return true;
  }

  function updateEcon() {
    const k = G.player, c = G.COUNTRIES[k];
    $('econ-flag').style.background = flagCss(c.flag);
    $('econ-money').textContent = Math.floor(G.money[k]);
    $('econ-income').textContent = `+${G.income[k].toFixed(1)}/s`;
    refreshCard();
  }

  // ---------- events, victory and defeat
  function toast(html, warn) {
    const el = document.createElement('div');
    el.className = 'toast' + (warn ? ' warn' : '');
    el.innerHTML = html;
    $('toasts').appendChild(el);
    while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
    setTimeout(() => el.remove(), 5000);
  }
  const flagHtml = k => `<span class="flag" style="background:${flagCss(G.COUNTRIES[k].flag)}"></span>`;
  let ended = false, warned = false;
  function endGame(title, text) {
    ended = true;
    $('end-title').textContent = title; $('end-text').textContent = text;
    $('endgame').hidden = false;
  }
  $('end-watch').addEventListener('click', () => { $('endgame').hidden = true; });
  $('end-lapse').addEventListener('click', () => startReplay());
  $('end-new').addEventListener('click', () => { location.search = '?seed=' + (Math.random() * 1e9 | 0); });

  function handleEvents() {
    for (const e of G.events.splice(0)) {
      if (e.type === 'cutoff') {
        if (e.k === G.player) { toast(`${flagHtml(e.k)} ${e.n} division${e.n > 1 ? 's' : ''} cut off from supply - reopen a route or lose them`, true); G.effects.push({ type: 'ping', x: e.x, y: e.y, t: 0, life: 1 }); }
        continue;
      }
      if (e.type === 'surrender') {
        if (e.to === G.player) toast(`${flagHtml(e.k)} An encircled ${G.COUNTRIES[e.k].name} division surrendered to you &nbsp;<b style="color:#8fd694">+${e.reward}</b>`);
        else if (e.k === G.player) toast(`${flagHtml(e.k)} One of your divisions starved and surrendered${e.to >= 0 ? ' to ' + G.COUNTRIES[e.to].name : ''}`, true);
        continue;
      }
      toast(`${flagHtml(e.k)} ${G.COUNTRIES[e.k].name} has capitulated to ${flagHtml(e.to)} ${G.COUNTRIES[e.to].name}`, e.k === G.player);
      chips[e.k].classList.add('dead');
      if (e.k === G.player && !ended) endGame('DEFEAT', `${G.COUNTRIES[e.to].name} took ${G.COUNTRIES[e.k].capital}. Your country has capitulated.`);
    }
    if (G.winner >= 0 && !ended) endGame(G.winner === G.player ? 'VICTORY' : 'WAR OVER', `${G.COUNTRIES[G.winner].name} is the last country standing.`);
    const occ = G.occupy[G.player] > 0;
    if (occ && !warned) toast(`${flagHtml(G.player)} ${G.COUNTRIES[G.player].capital} is occupied - retake it or capitulate!`, true);
    warned = occ;
  }

  // strength facing each neighbour + gaps in the line
  let frontsT = 0, frontsHtml = '';
  function updateFronts(force) {
    if (!force && performance.now() < frontsT) return;   // walks every unit x province: once a second is plenty
    frontsT = performance.now() + 1000;
    const rep = G.dead[G.player] ? { fronts: [], gaps: [] } : G.frontReport(G.player);
    ui.gaps = rep.gaps;
    ui.supply = ui.showSupply && !G.dead[G.player] ? G.supplyReport(G.player) : null;
    const mine = G.units.filter(u => u.k === G.player), cut = mine.filter(u => u.sup === 0).length, strained = mine.filter(u => u.sup === 1).length;
    const html = rep.fronts.map(f => {
      const tot = f.mine + f.theirs || 1;
      return `<div class="front${f.mine < f.theirs * 0.8 ? ' losing' : ''}">${flagHtml(f.e)}<span class="meter"><span style="width:${f.mine / tot * 100}%"></span></span><span class="nums">${f.mine.toFixed(1)} : ${f.theirs.toFixed(1)}</span></div>`;
    }).join('') + (cut || strained ? `<div class="front losing"><span class="nums" style="min-width:0;text-align:left">Supply: ${cut ? cut + ' cut off' : ''}${cut && strained ? ', ' : ''}${strained ? strained + ' strained' : ''} &nbsp;(Tab)</span></div>` : '');
    if (html !== frontsHtml) $('fronts').innerHTML = frontsHtml = html;
  }

  function updateHud(chipsOnly) {
    if (!chipsOnly) { handleEvents(); updateFronts(); }
    chips.forEach((el, k) => {
      const pct = G.stats.share[k] * 100;
      el.querySelector('.pct').textContent = pct.toFixed(0) + '%';
      el.querySelector('.share').style.width = pct + '%';
    });
  }

  function updateSelPanel() {
    const sel = selected(), panel = $('sel-panel');
    refreshCard();
    panel.hidden = !sel.length;
    if (!sel.length) return;
    const avg = sel.reduce((s, u) => s + u.str, 0) / sel.length;
    $('sel-flag').style.background = flagCss(G.COUNTRIES[G.player].flag);
    const holding = sel.filter(u => u.mode === 'front').length;
    const back = sel.filter(u => u.falling).length, blocked = sel.filter(u => u.blocked).length;
    $('sel-text').textContent = `${sel.length} division${sel.length > 1 ? 's' : ''}` + (back ? ` · ${back} falling back` : '') + (blocked ? ` · ${blocked} can't get there` : '') + (holding ? ` · ${holding === sel.length ? 'holding' : holding + ' holding'} the front` : '');
    $('sel-bar').style.width = avg * 100 + '%';
    $('sel-bar').style.background = `hsl(${Math.round(avg * 115)},70%,52%)`;
  }

  let speed = 1, lastSpeed = 1;
  function setSpeed(s, fromNet) {
    if (lockstep && !lockstep.solo && !fromNet) { if (lockstep.isHost) issue({ t: 'speed', v: s }); return; }   // the host sets the pace for everyone
    speed = s; if (s) lastSpeed = s;
    document.querySelectorAll('#speed button').forEach(b => b.classList.toggle('active', +b.dataset.speed === s));
  }
  document.querySelectorAll('#speed button').forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));

  // ---------- loop
  // ---------- timelapse: every couple of game-seconds remember who holds each cell
  // and where the divisions are; at the end, play the war back by writing those
  // frames (blended, so the front glides) into the live control field.
  let replay = null;
  function startReplay() {
    if (REC.frames.length < 2) return;
    replay = { pos: 0, playing: true, saved: { ctl: G.ctl.slice(), units: G.units, buildings: G.buildings, jets: G.jets, shells: G.shells, effects: G.effects, clashes: G.clashes }, ghosts: new Map() };
    G.buildings = []; G.jets = []; G.shells = []; G.effects = []; G.clashes = [];
    for (const u of G.units) u.sel = false;
    ui.gaps = null; ui.supply = null; ui.hover = ui.hoverProv = ui.hoverB = null; ui.build = null;
    $('endgame').hidden = true; $('replay').hidden = false;
    document.body.classList.add('replaying');
    goal.x = WORLD_W / 2; goal.y = WORLD_H / 2; goal.zoom = fit() * 1.05;
  }
  function stopReplay() {
    const s = replay.saved;
    G.ctl.set(s.ctl); G.units = s.units; G.buildings = s.buildings; G.jets = s.jets; G.shells = s.shells; G.effects = s.effects; G.clashes = s.clashes;
    replay = null;
    $('replay').hidden = true; $('endgame').hidden = !ended;
    document.body.classList.remove('replaying');
    G.computeStats();
  }
  function replayFrame(dt) {
    const F = REC.frames, n = F.length - 1;
    if (replay.playing) { replay.pos += dt / 25; if (replay.pos >= 1) { replay.pos = 1; replay.playing = false; } }
    const f = replay.pos * n, i = Math.min(n - 1, f | 0), w = f - i, A = F[i], B = F[i + 1], ctl = G.ctl;
    for (let c = 0, o = 0; c < G.N; c++, o += 4) { ctl[o] = ctl[o + 1] = ctl[o + 2] = ctl[o + 3] = 0; ctl[o + (A.own[c >> 2] >> (c & 3) * 2 & 3)] += 1 - w; ctl[o + (B.own[c >> 2] >> (c & 3) * 2 & 3)] += w; }
    // divisions: glide between the two frames; ones that die in between simply stay until the next frame
    const next = new Map(B.units.map(q => [q[0], q])), ghosts = replay.ghosts, out = [];
    for (const q of A.units) {
      let g = ghosts.get(q[0]);
      if (!g) ghosts.set(q[0], g = { id: q[0], k: q[1], type: q[4], age: 1, str: 1, sup: 2, dig: 0, bonus: 0, sel: false, holdIds: [], hasTarget: false, path: null, mode: null, falling: null, blocked: false });
      const b = next.get(q[0]);
      g.x = b ? lerp(q[2], b[2], w) : q[2]; g.y = b ? lerp(q[3], b[3], w) : q[3];
      out.push(g);
    }
    G.units = out;
    $('replay-bar').value = replay.pos * 1000;
    const t = lerp(A.t, B.t, w) | 0;
    $('replay-time').textContent = `${t / 60 | 0}:${String(t % 60).padStart(2, '0')}`;
    $('replay-play').textContent = replay.playing ? '❚❚' : replay.pos >= 1 ? '↺' : '▶';
  }
  $('replay-play').addEventListener('click', () => { if (replay.pos >= 1) replay.pos = 0; replay.playing = !replay.playing || replay.pos === 0; });
  $('replay-bar').addEventListener('input', e => { replay.pos = e.target.value / 1000; replay.playing = false; });
  $('replay-close').addEventListener('click', stopReplay);

  const TICK = Net.TICK;
  let last = performance.now(), hudT = 0, acc = 0, waiting = 0, ticked = true;
  function tickOnce() {
    for (const u of G.units) { u.ox = u.x; u.oy = u.y; }
    for (const j of G.jets) { j.ox = j.x; j.oy = j.y; }
    if (lockstep) return lockstep.advance();
    for (const c of localQueue.splice(0)) onExec(G.player, c, G.exec(G.player, c));
    G.step(TICK);
    return true;
  }
  // A hidden tab gets no animation frames, which in a network game would freeze
  // everyone else (they wait for our turn packets). So while hidden, keep the
  // simulation ticking from a worker timer - those are not throttled.
  const headlessTest = new URLSearchParams(location.search).has('norender');   // test aid: no drawing, tick from the timer
  if (headlessTest) document.body.style.display = 'none';
  const bgTimer = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33);'], { type: 'text/javascript' })));
  // In a network game this timer - not the animation frame - advances the
  // simulation, by wall-clock time. So a player whose drawing is slow (or whose
  // tab is hidden) still keeps pace and doesn't hold everyone else up.
  let netLast = performance.now(), netTicked = false;
  bgTimer.onmessage = () => {
    const now = performance.now(), dt = Math.min(0.25, (now - netLast) / 1000);
    netLast = now;
    if (!lockstep || replay) return;
    acc += dt * speed;
    let n = 0;
    while (acc >= TICK && n < 8) {
      if (!tickOnce()) { acc = 0; waiting += dt; break; }   // waiting for another player's turn packet
      waiting = 0; acc -= TICK; n++;
    }
    if (n) netTicked = true;
    if (n === 8) acc = 0;
    record();
  };

  function frame(now) {
    requestAnimationFrame(frame);   // first, so an error in one frame can't stop the loop
    const dt = clamp((now - last) / 1000, 0, 0.05); last = now;
    updateCamera(dt);
    if (replay) {
      replayFrame(dt);
      if ((hudT -= dt) <= 0) { hudT = 0.2; G.computeStats(); updateHud(true); }
    } else {
      if (lockstep) { ticked = netTicked; netTicked = false; }   // the timer above does the ticking
      else {
        acc += dt * speed;
        let n = 0;
        while (acc >= TICK && n < 8) { tickOnce(); acc -= TICK; n++; }
        ticked = n > 0;
        if (n === 8) acc = 0;   // fell behind (tab was in the background): don't try to catch up all at once
        record();
      }
      $('net-wait').hidden = !lockstep || waiting < 0.6;
      for (let i = G.effects.length - 1; i >= 0; i--) { const e = G.effects[i]; e.t += dt; if (e.t >= e.life) G.effects.splice(i, 1); }
      if (ui.flash && (ui.flash.t += dt) >= 0.45) ui.flash = null;
      if (attract) attractFrame(now);
      else if ((hudT -= dt) <= 0) { hudT = 0.2; updateHud(); updateSelPanel(); updateEcon(); if (tut) tut.update(); }
    }

    resolveHover();
    ui.time = now / 1000; ui.dt = dt; ui.replaying = !!replay;
    ui.paused = speed === 0 && !replay && !attract;
    if ($('paused').hidden === ui.paused) $('paused').hidden = !ui.paused;
    ui.dirty = !!replay || ticked;
    ui.box = drag && drag.type === 'box' && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) >= 5 ? drag : null;
    const slots = drag && drag.type === 'order' ? orderSlots(selected(), drag.a, drag.b) : [];
    ui.order = slots.length ? slots : null;
    // draw divisions and jets between their last two ticks, so 30 Hz simulation still moves like 60+
    const al = replay ? 1 : Math.min(1, acc / TICK), moved = [];
    if (al < 1) for (const list of [G.units, G.jets]) for (const o of list) {
      if (o.ox === undefined) continue;
      moved.push(o, o.x, o.y);
      o.x = o.ox + (o.x - o.ox) * al; o.y = o.oy + (o.y - o.oy) * al;
    }
    if (!headlessTest) R.draw(ui);
    for (let i = 0; i < moved.length; i += 3) { moved[i].x = moved[i + 1]; moved[i].y = moved[i + 2]; }
  }

  // ---------- start menu and multiplayer lobby
  const qs = new URLSearchParams(location.search);
  let lobby = null;
  function menuStatus(t) { $('menu-status').textContent = t || ''; }
  function closeMenu() { $('menu').hidden = true; document.body.classList.remove('home'); attract = false; setSpeed(1, true); }

  // ---------- home page: an all-AI war runs behind it
  let attract = false, tut = null;
  function showPanel(name) {
    const ids = { play: 'panel-play', tutorial: 'panel-tutorial', multi: 'menu-main', controls: 'panel-controls', lobby: 'menu-lobby' };
    for (const k in ids) $(ids[k]).hidden = k !== name;
    document.querySelectorAll('#home-nav button').forEach(b => b.classList.toggle('on', b.dataset.panel === (name === 'lobby' ? 'multi' : name)));
  }
  function newGame(seed, k) {   // a fresh single-player war
    G.init(seed); R.init($('map'), overlay);
    lockstep = null; localQueue.length = 0; acc = 0;
    REC.frames.length = 0; REC.next = 0; REC.every = 2;
    ended = false; warned = false; $('endgame').hidden = true;
    chips.forEach(el => el.classList.remove('dead'));
    G.events.length = 0;
    setPlayer(k, true);
  }
  function openHome() {
    document.body.classList.add('home'); $('menu').hidden = false; showPanel('play');
    attract = true; G.player = -1;   // nobody is human: the AI fights it out as a backdrop
    for (const u of G.units) u.sel = false;
    setSpeed(2, true);
  }
  function attractFrame(now) {
    G.events.length = 0;
    const t = now / 1000;   // slow drift over the map
    goal.x = WORLD_W / 2 + Math.sin(t * 0.05) * 320; goal.y = WORLD_H / 2 + Math.cos(t * 0.037) * 140; goal.zoom = fit() * 1.35;
    if (G.winner >= 0) { G.init(Math.random() * 1e9 | 0); R.init($('map'), overlay); G.player = -1; }
  }
  G.COUNTRIES.forEach((c, k) => {
    const el = document.createElement('button');
    el.className = 'country';
    el.innerHTML = `${flagHtml(k)}<div><b>${c.name}</b><span>attack x${c.atk} &nbsp; defence x${c.def} &nbsp; speed x${c.speed} &nbsp; division ${c.cost}</span></div><i>${c.trait}</i>`;
    el.addEventListener('click', () => { newGame(Math.random() * 1e9 | 0, k); closeMenu(); });
    $('pick-country').appendChild(el);
  });
  document.querySelectorAll('#home-nav button').forEach(b => b.addEventListener('click', () => showPanel(b.dataset.panel)));
  $('brand').addEventListener('click', () => { location.href = location.pathname; });

  // ---------- tutorial: a real game as France with the AI asleep. Each step
  // completes itself when the player does the thing (or can be skipped).
  function Tutorial() {
    let i = -1, t0 = 0, base = null, moved = 0, lastGoal = null, seen = {};
    const steps = [
      { title: 'Look around', text: 'Pan with <b>W A S D</b> or by dragging with the <b>middle mouse button</b>. Zoom with the <b>mouse wheel</b>.',
        done: () => moved > 260 },
      { title: 'Select your divisions', text: 'The French flags are your divisions. <b>Drag a box</b> around a few of them with the left mouse button.',
        done: () => selected().length >= 2 },
      { title: 'Attack a province', text: 'The map is cut into provinces. With divisions selected, <b>click a grey German province that touches your border</b>. Your divisions line up along its edge and start pushing.',
        done: () => seen.hold },
      { title: 'Watch the front move', text: 'Divisions never step onto enemy ground: they push the frontline forward and follow it. A <b>green arrow</b> on a flag means it attacks with a bonus, a <b>shield</b> means it defends with one. Wait until you have taken some ground.',
        enter: () => { base = G.stats.share[0]; }, done: () => G.stats.share[0] > base + 0.012 || performance.now() - t0 > 40000 },
      { title: 'Widen the attack', text: '<b>Shift-click</b> a second enemy province. The same divisions now attack both at once, as one long line.',
        done: () => seen.add },
      { title: 'Stances', text: 'The order card, bottom left, decides how divisions fight. Press <b>Q</b> for <b>Hold</b>: they stop pushing, dig in and defend far better. <b>R</b> is the normal attack.',
        pulse: ['units', 'q'], done: () => seen.stance },
      { title: 'Guard a province', text: 'Point at one of <b>your own border provinces</b> and press <b>X</b>. The selected divisions move there like an attack, but in Hold stance: they line its edge, dig in and defend. Use it for every stretch you are not attacking from.',
        pulse: ['units', 'x'], done: () => seen.front },
      { title: 'Recruit', text: 'Press <b>Esc</b> to deselect: the card now shows production. Land earns money - here is some extra. Press <b>Q</b> to recruit an infantry division; it appears at your capital.',
        enter: () => { G.money[0] += 300; }, pulse: ['base', 'q'], done: () => seen.recruit },
      { title: 'Supply', text: 'Press <b>Tab</b> for the supply map. Supply flows from your capital and barracks through land you hold. Divisions that are cut off weaken and surrender - so cut the enemy off, and guard your own flanks.',
        pulse: ['base', 'tab'], done: () => ui.showSupply },
      { title: 'Tools of war', text: '<b>Artillery</b> (R) and <b>jets</b> (F) blast ground next to your border. <b>Barracks</b> (T) move your muster point and extend supply. <b>Guards</b> (E) are tough and steady the units beside them. Hover any button for details.',
        manual: true },
      { title: 'How a war is won', text: 'Hold an enemy <b>capital for 20 seconds</b> and that country capitulates - its land becomes yours. Lose Paris the same way and you are out. The AI slept through this lesson; in a real war it fights back.',
        manual: true, last: true },
    ];
    const go = n => {
      i = n; t0 = performance.now(); moved = 0;
      const s = steps[i];
      if (s.enter) s.enter();
      $('tut').hidden = false; $('tut').classList.remove('done');
      $('tut-step').textContent = `Tutorial  ${i + 1} / ${steps.length}`;
      $('tut-title').textContent = s.title; $('tut-text').innerHTML = s.text;
      $('tut-next').textContent = s.last ? 'Play a real game' : s.manual ? 'Next' : 'Skip step';
      $('tut-next').className = s.manual ? 'go' : '';
    };
    this.onCmd = c => { if (c.t === 'hold') { seen.hold = true; if (c.add) seen.add = true; } if (c.t === 'set' && c.key === 'stance') seen.stance = true; if (c.t === 'front' || c.t === 'guard') seen.front = true; if (c.t === 'recruit') seen.recruit = true; };
    this.next = () => { if (steps[i].last) return this.end(true); go(i + 1); };
    this.end = toHome => { tut = null; $('tut').hidden = true; G.aiPassive = false; cardButtons.forEach(b => b.el.classList.remove('pulse')); if (toHome) openHome(); };
    this.update = () => {
      if (lastGoal) moved += Math.hypot(goal.x - lastGoal.x, goal.y - lastGoal.y) + Math.abs(goal.zoom - lastGoal.zoom) * 400;
      lastGoal = { ...goal };
      const s = steps[i];
      for (const b of cardButtons) b.el.classList.toggle('pulse', !!s.pulse && s.pulse[0] === cardName && s.pulse[1] === b.item.key);
      if (!s.manual && s.done() && performance.now() - t0 > 900) { $('tut').classList.add('done'); go(i + 1); }
    };
    go(0);
  }
  function startTutorial() {
    newGame(20260918, 0); G.aiPassive = true; ui.showSupply = false;
    closeMenu();
    goal.x = G.caps[0].x + 200; goal.y = G.caps[0].y; goal.zoom = fit() * 1.6;
    tut = new Tutorial();
  }
  $('tut-start').addEventListener('click', startTutorial);
  $('tut-next').addEventListener('click', () => tut && tut.next());
  $('tut-exit').addEventListener('click', () => tut && tut.end(true));
  function showLobby(state, selfId, isHost, code) {
    showPanel('lobby');
    $('lobby-code').textContent = code;
    $('lobby-seats').innerHTML = '';
    G.COUNTRIES.forEach((c, k) => {
      const who = state.seats[k], el = document.createElement('button');
      el.className = 'seat' + (who === selfId ? ' me' : who ? ' taken' : '');
      el.innerHTML = `${flagHtml(k)}<b>${c.name}</b><span>${c.trait}</span><i>${who === selfId ? 'You' : who ? 'Player ' + who.slice(0, 4) : 'AI - click to take'}</i>`;
      el.addEventListener('click', () => lobby.pick(k));
      $('lobby-seats').appendChild(el);
    });
    const n = Object.values(state.seats).filter(Boolean).length;
    $('lobby-start').hidden = !isHost;
    $('lobby-start').textContent = n > 1 ? `Start with ${n} players` : 'Waiting for players... (start anyway)';
    $('lobby-note').textContent = isHost ? 'Share the room code. Empty seats are played by the AI.' : 'Waiting for the host to start.';
  }
  async function openRoom(isHost, fixedCode) {
    const code = (fixedCode || (isHost ? Math.random().toString(36).slice(2, 7) : $('join-code').value.trim())).toUpperCase();
    if (!code) return menuStatus('Enter the room code first.');
    menuStatus('Connecting...');
    let T;
    try { T = await ($('menu-local').checked ? Net.broadcastTransport(code) : Net.trysteroTransport(code)); }
    catch (err) { return menuStatus('Could not start networking: ' + err.message); }
    menuStatus('');
    lobby = new Net.Lobby(T, isHost, 'Player', {
      onLobby: state => {
        showLobby(state, T.selfId, isHost, code);
        if (isHost && qs.has('autostart') && Object.values(state.seats).filter(Boolean).length >= +qs.get('autostart')) setTimeout(() => lobby.start(), 0);
      },
      onStart: state => {
        const seats = {};
        for (const k in state.seats) if (state.seats[k]) seats[state.seats[k]] = +k;
        G.init(state.seed); R.init($('map'), overlay);
        G.net = true; G.humans = new Set(Object.values(seats));
        REC.frames.length = 0; REC.next = 0; ended = false; warned = false; tut = null; $('endgame').hidden = true; $('tut').hidden = true;
        lockstep = new Net.Lockstep({ G, transport: T, seats, hostId: state.hostId, onExec, onSpeed: v => setSpeed(v, true), onStatus: t => toast(t, true) });
        chips.forEach(el => el.classList.remove('dead'));
        setPlayer(seats[T.selfId], true);
        closeMenu();
      },
    });
    if (!isHost) showPanel('lobby'), $('lobby-code').textContent = code, $('lobby-note').textContent = 'Looking for the host...', $('lobby-start').hidden = true;
  }
  // ?host=CODE / ?join=CODE (&local for the same-PC transport, &autostart=N to start once N players are in)
  if (qs.has('host') || qs.has('join')) { $('menu-local').checked = qs.has('local'); openRoom(qs.has('host'), qs.get('host') || qs.get('join')); }
  if (qs.has('report')) {   // test aid: publish sync status once a second
    const ch = new BroadcastChannel('frontline-report'), me = qs.get('report');
    setInterval(() => ch.postMessage({ me, turn: lockstep ? lockstep.turn : -1, sum: G.checksum(), units: G.units.length, player: G.player, speed, dbg: lockstep && lockstep.debug() }), 1000);
    if (qs.has('bot')) setInterval(() => {   // and play a little, so there are commands to keep in step
      if (!lockstep) return;
      const mine = G.units.filter(u => u.k === G.player), fp = G.frontProvinces(G.player);
      if (mine.length && fp.length) issue({ t: 'hold', ids: idsOf(mine.filter(() => Math.random() < 0.5)), p: fp[Math.random() * fp.length | 0].id, add: false });
      if (Math.random() < 0.5) issue({ t: 'recruit', type: 'infantry' });
    }, 2500);
  }
  $('menu-host').addEventListener('click', () => openRoom(true));
  $('menu-join').addEventListener('click', () => openRoom(false));
  $('lobby-start').addEventListener('click', () => lobby.start());

  // ?order=x,y (world coords, test aid): select all and advance into that province
  const testOrder = new URLSearchParams(location.search).get('order');
  const testLapse = new URLSearchParams(location.search).get('lapse');
  ui.showSupply = new URLSearchParams(location.search).has('supply');   // ?supply: start with the supply map on
  // test/deep links (?seed ?warm ?order ?lapse ?supply ?sp) skip the menu
  const skipMenu = ['seed', 'warm', 'order', 'lapse', 'supply', 'sp', 'pause'].some(q => qs.has(q));
  $('menu').hidden = true;
  setSpeed(1);
  setPlayer(Math.max(0, G.dead.indexOf(false)));
  if (qs.has('tutorial')) startTutorial();
  else if (!skipMenu && !qs.has('host') && !qs.has('join')) openHome();
  else if (qs.has('host') || qs.has('join')) { document.body.classList.add('home'); $('menu').hidden = false; }
  if (testOrder) {
    const [x, y] = testOrder.split(',').map(Number), p = G.provinces.get(G.provAt(x, y));
    for (const u of G.units) u.sel = u.k === G.player;
    if (p) { orderProvince(p); ui.hoverProv = p; }
  }
  goal.x = WORLD_W / 2; goal.y = WORLD_H / 2;
  if (qs.has('pause')) { for (let i = 0; i < 90; i++) tickOnce(); setSpeed(0); }   // test aid: play three seconds, then freeze
  if (testLapse) { startReplay(); if (replay) { replay.pos = +testLapse; replay.playing = false; } }
  requestAnimationFrame(frame);
})();
