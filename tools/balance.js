// Balance harness: runs all-AI wars headlessly and reports how each country fares.
//
//   node tools/balance.js                       12 wars, current rules
//   node tools/balance.js --seeds 24            more wars (slower, less noisy)
//   node tools/balance.js --set COUNTRIES.2.cost=80 --set TUNE.upkeep=0.005
//                                               try a rule change without editing the game
//   node tools/balance.js --json out.json       also write the raw numbers
//
// --set paths are relative to G (COUNTRIES.<i>.<field>, UNIT_TYPES.guard.cost, TUNE.<field>,
// BUILDINGS.artillery.cost, JET.cost, SUPPLY.full, GUARD_AURA.hold ...). Countries: 0 France,
// 1 Germany, 2 Poland, 3 Italy. Arrays: TUNE.terrAtk.2=0.5
'use strict';
const path = require('path'), fs = require('fs');
const args = process.argv.slice(2), sets = [];
let nSeeds = 12, maxSec = 1500, jsonOut = null, simPath = path.join(__dirname, '..', 'js', 'sim.js');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seeds') nSeeds = +args[++i];
  else if (args[i] === '--max') maxSec = +args[++i];
  else if (args[i] === '--set') sets.push(args[++i]);
  else if (args[i] === '--json') jsonOut = args[++i];
  else if (args[i] === '--sim') simPath = path.resolve(args[++i]);
}
global.window = {};
require(simPath);
const G = window.G, NC = 4, names = G.COUNTRIES.map(c => c.name);
for (const s of sets) {
  const [p, v] = s.split('='), keys = p.split('.');
  let o = G;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = isNaN(+v) ? v : +v;
}

const T = () => names.map(() => 0);
const R = { wars: 0, unfinished: 0, length: [], wins: T(), place: T(), firstOut: T(), survive: names.map(() => []),
  share: { 60: T(), 120: T(), 240: T(), 480: T() }, shareN: { 60: 0, 120: 0, 240: 0, 480: 0 },
  bought: T(), boughtGuards: T(), lost: T(), surrendered: T(), killsCredited: T(), peakArmy: T(), armySum: T(), armyN: 0,
  incomeSum: T(), floorTime: T(), aliveTime: T(), bankSum: T(), guns: T(), jets: T(), barracks: T(), capsTaken: T(), spent: T() };

for (let w = 0; w < nSeeds; w++) {
  const seed = 1000 + w * 7919;
  G.init(seed); G.player = -1;
  const seen = new Map(), out = [], peak = T();
  let s = 0;
  for (const u of G.units) seen.set(u.id, u.k);
  for (s = 1; s <= maxSec && G.winner < 0; s++) {
    for (let i = 0; i < 30; i++) G.step(1 / 30);
    const alive = new Set();
    const army = T();
    for (const u of G.units) {
      alive.add(u.id); army[u.k]++;
      if (!seen.has(u.id)) { seen.set(u.id, u.k); R.bought[u.k]++; R.spent[u.k] += G.unitCost(u.k, u.type); if (u.type === 'guard') R.boughtGuards[u.k]++; }
    }
    for (const [id, k] of seen) if (!alive.has(id)) { R.lost[k]++; seen.delete(id); }
    for (const e of G.events.splice(0)) {
      if (e.type === 'surrender') { R.surrendered[e.k]++; if (e.to >= 0) R.killsCredited[e.to]++; }
      if (e.type === 'capitulate') { out.push(e.k); R.capsTaken[e.to]++; R.survive[e.k].push(s); }
    }
    for (let k = 0; k < NC; k++) {
      if (G.dead[k]) continue;
      peak[k] = Math.max(peak[k], army[k]); R.armySum[k] += army[k];
      R.aliveTime[k]++; R.incomeSum[k] += G.income[k]; R.bankSum[k] += G.money[k];
      if (G.income[k] <= 0.51) R.floorTime[k]++;
    }
    if (R.share[s]) { for (let k = 0; k < NC; k++) R.share[s][k] += G.stats.share[k]; R.shareN[s]++; }
  }
  R.wars++; R.length.push(s);
  if (G.winner < 0) R.unfinished++;
  // placing: winner 1st, then reverse order of elimination; the undecided share the remaining places by map share
  const left = [0, 1, 2, 3].filter(k => !out.includes(k)).sort((a, b) => G.stats.share[b] - G.stats.share[a]);
  left.forEach((k, i) => { R.place[k] += i + 1; if (G.winner < 0 || i > 0) R.survive[k].push(s); });
  out.slice().reverse().forEach((k, i) => { R.place[k] += left.length + i + 1; });
  if (G.winner >= 0) R.wins[G.winner]++;
  if (out.length) R.firstOut[out[0]]++;
  for (let k = 0; k < NC; k++) R.peakArmy[k] += peak[k];
  for (const b of G.buildings) (b.type === 'artillery' ? R.guns : R.barracks)[b.k]++;
  for (const j of G.jets) R.jets[j.k]++;
  process.stderr.write(`war ${w + 1}/${nSeeds} seed ${seed}: ${G.winner >= 0 ? names[G.winner] + ' wins' : 'undecided'} after ${s}s, out: ${out.map(k => names[k]).join(' > ') || '-'}\n`);
}

const med = a => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : 0, n = R.wars;
const row = (label, f) => console.log(label.padEnd(38) + names.map((_, k) => String(f(k)).padStart(14)).join(''));
console.log(`\n${n} all-AI wars${sets.length ? '  with ' + sets.join(', ') : ''}   median length ${med(R.length)}s, undecided at ${maxSec}s: ${R.unfinished}`);
console.log(''.padEnd(38) + names.map(x => x.padStart(14)).join(''));
row('wins', k => R.wins[k]);
row('average place (1 = won)', k => (R.place[k] / n).toFixed(2));
row('eliminated first', k => R.firstOut[k]);
row('median survival (s)', k => med(R.survive[k]));
for (const t of [60, 120, 240, 480]) row(`map share at ${t}s`, k => R.shareN[t] ? (R.share[t][k] / R.shareN[t]).toFixed(3) : '-');
row('division price', k => G.COUNTRIES[k].cost);
row('divisions bought per war', k => (R.bought[k] / n).toFixed(1));
row('  of which guards', k => (R.boughtGuards[k] / n).toFixed(1));
row('money spent on units per war', k => Math.round(R.spent[k] / n));
row('average army while alive', k => (R.armySum[k] / Math.max(1, R.aliveTime[k])).toFixed(1));
row('peak army (avg of wars)', k => (R.peakArmy[k] / n).toFixed(1));
row('divisions lost per war', k => (R.lost[k] / n).toFixed(1));
row('  of which surrendered', k => (R.surrendered[k] / n).toFixed(1));
row('enemy surrenders credited per war', k => (R.killsCredited[k] / n).toFixed(1));
row('average income /s while alive', k => (R.incomeSum[k] / Math.max(1, R.aliveTime[k])).toFixed(1));
row('% of life at the income floor', k => (R.floorTime[k] / Math.max(1, R.aliveTime[k]) * 100).toFixed(0) + '%');
row('average bank', k => Math.round(R.bankSum[k] / Math.max(1, R.aliveTime[k])));
row('capitals taken per war', k => (R.capsTaken[k] / n).toFixed(2));
row('guns / barracks / jets at the end', k => `${(R.guns[k] / n).toFixed(1)}/${(R.barracks[k] / n).toFixed(1)}/${(R.jets[k] / n).toFixed(1)}`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ names, sets, R }, null, 1));
