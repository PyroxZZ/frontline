'use strict';
// Multiplayer without a server: every machine runs the whole simulation and only
// the players' commands travel (lockstep). Time is cut into turns of TURN_TICKS
// simulation ticks; a command issued during turn T is executed by everyone at the
// start of turn T + DELAY, in seat order. A turn only starts once every player's
// packet for it has arrived, so nobody can run ahead. Checksums ride along with
// the packets; if the host sees one that differs from its own it sends everyone
// (itself included) a full snapshot to continue from.
//
// Transports only need: selfId, send(msg, toPeer?), on(fn(msg, fromPeer)),
// onLeave(fn(peer)). Provided here: Trystero (WebRTC, signalling over public
// relays - no backend of our own) and BroadcastChannel (two tabs on one PC).
(function () {
  const Net = window.Net = {};
  const TURN_TICKS = 3, DELAY = 2, SUM_EVERY = 10, KEEP = 200;
  Net.TICK = 1 / 30;

  // opts: { G, transport, seats: { peerId: countryIndex }, hostId, onExec(k, cmd, result), onSpeed(v), onStatus(text) }
  Net.Lockstep = function (opts) {
    const G = opts.G, T = opts.transport, self = T.selfId, isHost = self === opts.hostId;
    const seats = opts.seats, active = new Set(Object.keys(seats)), lastOf = {};   // lastOf[peer] = last turn a departed peer counts for
    const packets = new Map(), sums = new Map(), queue = [];
    let turn = 0, tick = 0, sentUpTo = DELAY - 1, lastResync = -1e9, pendingSnap = null, solo = false;

    const bucket = t => { let b = packets.get(t); if (!b) packets.set(t, b = new Map()); return b; };
    const needs = (peer, t) => active.has(peer) || (lastOf[peer] !== undefined && t <= lastOf[peer]);

    function sendPacket(forTurn) {
      const pkt = { t: 'pkt', turn: forTurn, cmds: queue.splice(0) };
      if (turn % SUM_EVERY === 0) { pkt.st = turn; pkt.sum = G.checksum(); noteSum(self, turn, pkt.sum); }
      bucket(forTurn).set(self, pkt.cmds);
      T.send(pkt);
    }

    function noteSum(peer, t, sum) {
      let m = sums.get(t); if (!m) sums.set(t, m = new Map());
      m.set(peer, sum);
      if (!isHost || !m.has(self)) return;
      for (const [q, v] of m) if (v !== m.get(self) && performance.now() - lastResync > 4000) { lastResync = performance.now(); wantResync = true; if (opts.onStatus) opts.onStatus('Out of sync with ' + q.slice(0, 4) + ' - resyncing'); }
    }
    let wantResync = false;

    function loadSnap(s) {
      G.deserialize({ meta: s.meta, ctl: s.ctl });
      turn = s.turn; tick = 0; sums.clear();
      if (sentUpTo < turn + DELAY - 1) { for (let t = Math.max(sentUpTo + 1, turn); t < turn + DELAY; t++) bucket(t).set(self, bucket(t).get(self) || []); }
    }

    T.on((msg, from) => {
      if (solo) return;
      if (msg.t === 'pkt') { bucket(msg.turn).set(from, msg.cmds); if (msg.sum !== undefined) noteSum(from, msg.st, msg.sum); }
      else if (msg.t === 'snap' && from === opts.hostId) pendingSnap = msg;
      else if (msg.t === 'gone' && from === opts.hostId) { active.delete(msg.peer); lastOf[msg.peer] = msg.last; }
    });
    T.onLeave(peer => {
      if (solo || !active.has(peer)) return;
      if (peer === opts.hostId) {   // no host, no referee: carry on alone, the AI takes the others over
        solo = true;
        for (const p of Object.keys(seats)) if (p !== self) G.humans.delete(seats[p]);
        if (opts.onStatus) opts.onStatus('The host left - you are playing on alone');
        return;
      }
      if (!isHost) return;
      let last = turn + DELAY - 1;
      for (const [t, b] of packets) if (b.has(peer) && t > last) last = t;
      active.delete(peer); lastOf[peer] = last;
      T.send({ t: 'gone', peer, last });
      queue.push({ t: 'drop', k: seats[peer] });
      if (opts.onStatus) opts.onStatus(G.COUNTRIES[seats[peer]].name + ' left - the AI takes over');
    });

    this.issue = cmd => { queue.push(cmd); };
    this.isHost = isHost;
    Object.defineProperty(this, 'turn', { get: () => turn });
    Object.defineProperty(this, 'solo', { get: () => solo });
    this.debug = () => ({ turn, tick, sentUpTo, active: [...active], have: Object.fromEntries([turn, turn + 1, turn + 2].map(t => [t, [...(packets.get(t) || new Map()).keys()].map(p => p.slice(0, 4))])) });

    // Run one simulation tick if allowed. Returns false when waiting for another player's packet.
    this.advance = function () {
      if (solo) {
        for (const c of queue.splice(0)) exec(seats[self], c);
        G.step(Net.TICK); return true;
      }
      if (tick === 0) {
        if (pendingSnap) { loadSnap(pendingSnap); pendingSnap = null; }
        if (isHost && wantResync) {
          wantResync = false;
          const s = G.serialize(), msg = { t: 'snap', turn, meta: s.meta, ctl: s.ctl };
          T.send(msg); loadSnap(msg);   // the host takes the same round trip, so everyone is bit-identical
        }
        while (sentUpTo < turn + DELAY) sendPacket(++sentUpTo);
        const b = bucket(turn);
        if (turn >= DELAY) for (const peer of Object.keys(seats)) if (needs(peer, turn) && !b.has(peer)) return false;
        const order = Object.keys(seats).filter(p => b.has(p)).sort((p, q) => seats[p] - seats[q]);
        for (const peer of order) for (const c of b.get(peer)) exec(seats[peer], c);
        packets.delete(turn - KEEP); sums.delete(turn - KEEP);
      }
      G.step(Net.TICK);
      if (++tick === TURN_TICKS) { tick = 0; turn++; }
      return true;
    };

    function exec(k, c) {
      if (c.t === 'speed') { if (opts.onSpeed) opts.onSpeed(c.v); return; }
      const r = G.exec(k, c);
      if (opts.onExec) opts.onExec(k, c, r);
    }
  };

  // ---------- transports
  // Two tabs of the same browser on one PC (for trying multiplayer out locally).
  Net.broadcastTransport = function (room) {
    const selfId = Math.random().toString(36).slice(2, 10), ch = new BroadcastChannel('frontline-' + room);
    const handlers = [], leave = [], seen = new Map();
    ch.onmessage = e => {
      const { from, to, msg } = e.data;
      if (from === selfId || (to && to !== selfId)) return;
      seen.set(from, performance.now());
      if (msg.t === '_bye') { seen.delete(from); leave.forEach(f => f(from)); return; }
      if (msg.t !== '_hb') handlers.forEach(f => f(msg, from));
    };
    const send = (msg, to) => ch.postMessage({ from: selfId, to: to || null, msg });
    setInterval(() => { send({ t: '_hb' }); for (const [p, t] of seen) if (performance.now() - t > 4000) { seen.delete(p); leave.forEach(f => f(p)); } }, 1000);
    window.addEventListener('beforeunload', () => send({ t: '_bye' }));
    return Promise.resolve({ selfId, send, on: f => handlers.push(f), onLeave: f => leave.push(f) });
  };

  // WebRTC via Trystero: peers find each other through public relays, then talk directly.
  Net.trysteroTransport = async function (room) {
    const lib = await import('https://esm.run/trystero@0.21.0');
    const r = lib.joinRoom({ appId: 'frontline-rts-v1' }, room), handlers = [], leave = [];
    const [sendJson, getJson] = r.makeAction('m'), [sendBin, getBin] = r.makeAction('b');
    getJson((msg, from) => handlers.forEach(f => f(msg, from)));
    // the control field of a snapshot travels as binary, its description as metadata
    getBin((buf, from, meta) => handlers.forEach(f => f({ ...meta, ctl: new Float32Array(buf) }, from)));
    r.onPeerLeave(p => leave.forEach(f => f(p)));
    const send = (msg, to) => {
      if (msg.ctl) { const { ctl, ...meta } = msg; sendBin(ctl.buffer.slice(ctl.byteOffset, ctl.byteOffset + ctl.byteLength), to || null, meta); }
      else sendJson(msg, to || null);
    };
    return { selfId: lib.selfId, send, on: f => handlers.push(f), onLeave: f => leave.push(f), onJoin: f => r.onPeerJoin(f) };
  };

  // ---------- lobby: the host owns the seat list; everyone else asks
  // cb: { onLobby(state), onStart(state) }   state = { seed, seats: {k: peerId|null}, names: {peerId: name}, hostId }
  Net.Lobby = function (transport, isHost, name, cb) {
    const T = transport, self = T.selfId;
    let state = isHost ? { seed: Math.random() * 1e9 | 0, seats: { 0: self, 1: null, 2: null, 3: null }, names: { [self]: name }, hostId: self } : null;
    const publish = () => { T.send({ t: 'lobby', state }); cb.onLobby(state); };
    T.on((msg, from) => {
      if (isHost) {
        if (msg.t === 'hello') { state.names[from] = msg.name; const free = [0, 1, 2, 3].find(k => !state.seats[k]); if (free !== undefined && !Object.values(state.seats).includes(from)) state.seats[free] = from; publish(); }
        else if (msg.t === 'pick' && !state.seats[msg.k]) { for (const k in state.seats) if (state.seats[k] === from) state.seats[k] = null; state.seats[msg.k] = from; publish(); }
      } else if (msg.t === 'lobby') { state = msg.state; cb.onLobby(state); }
      else if (msg.t === 'start') cb.onStart(msg.state);
    });
    T.onLeave(peer => { if (!isHost || !state) return; for (const k in state.seats) if (state.seats[k] === peer) state.seats[k] = null; delete state.names[peer]; publish(); });
    if (T.onJoin) T.onJoin(() => { if (isHost) publish(); else T.send({ t: 'hello', name }); });
    this.pick = k => { if (isHost) { if (!state.seats[k]) { for (const q in state.seats) if (state.seats[q] === self) state.seats[q] = null; state.seats[k] = self; publish(); } } else T.send({ t: 'pick', k }); };
    this.start = () => { if (isHost) { T.send({ t: 'start', state }); cb.onStart(state); } };
    this.hello = () => { if (isHost) publish(); else T.send({ t: 'hello', name }); };
    this.hello();
    if (!isHost) { const again = setInterval(() => { if (state) clearInterval(again); else T.send({ t: 'hello', name }); }, 1500); }
  };
})();
