'use strict';
// Two layers: a WebGL2 canvas that shades the map (territory, frontline, coast)
// per pixel from the control texture, and a 2D canvas on top for flags and UI.
(function () {
  const G = window.G, R = window.R = {};
  const { WORLD_W, WORLD_H, GW, GH, NC, CELL, clamp, lerp } = G;

  const VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FS = `#version 300 es
precision highp float;
uniform sampler2D uCtl, uLand;
uniform vec2 uRes, uCam, uWorld, uGrid;
uniform float uZoom, uTime, uFlashA;
uniform vec3 uCol[4];
uniform sampler2D uEdge;
uniform float uEdgeMax;
// highlighted provinces (0 = hovered, 1 = flashing): seed, then up to 48 nearby seeds each
uniform vec2 uSelP[2];
uniform float uSelR[2];
uniform vec2 uSelN[32];
uniform int uSelCount[2];

// Inside province k = closer to its seed than to any neighbouring seed.
// Only pixels near the seed pay for the loop.
bool inProv(int k, vec2 w) {
  if (uSelCount[k] == 0) return false;
  vec2 dv = w - uSelP[k];
  float q = dot(dv, dv);
  if (q > uSelR[k] * uSelR[k]) return false;
  for (int i = 0; i < uSelCount[k]; i++) { vec2 e = w - uSelN[k * 16 + i]; if (dot(e, e) < q) return false; }
  return true;
}
out vec4 outColor;

vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}

// 4-tap B-spline bicubic: keeps the frontline free of grid artefacts.
vec4 texBicubic(sampler2D t, vec2 uv, vec2 size) {
  vec2 tc = uv * size - 0.5;
  vec2 f = fract(tc);
  tc -= f;
  vec4 xc = cubic(f.x), yc = cubic(f.y);
  vec4 c = tc.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.x + xc.y, xc.z + xc.w, yc.x + yc.y, yc.z + yc.w);
  vec4 off = (c + vec4(xc.y, xc.w, yc.y, yc.w) / s) / size.xxyy;
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(texture(t, off.yw), texture(t, off.xw), sx),
             mix(texture(t, off.yz), texture(t, off.xz), sx), sy);
}

void main() {
  vec2 sp = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 w = uCam + (sp - 0.5 * uRes) / uZoom;
  vec2 uv = w / uWorld;

  float h = texBicubic(uLand, uv, uGrid).r;
  vec2 hg = vec2(dFdx(h), dFdy(h));
  float hpx = (h - 0.5) / max(length(hg), 1e-6);
  float land = smoothstep(-0.8, 0.8, hpx);

  // sea
  vec3 sea = mix(vec3(0.063, 0.110, 0.161), vec3(0.118, 0.220, 0.310), smoothstep(0.12, 0.5, h));
  sea += 0.022 * smoothstep(0.3, 0.5, h) * sin(h * 140.0 - uTime * 1.2);

  // territory
  vec4 c = texBicubic(uCtl, uv, uGrid);
  float b = -1.0, s = -1.0; int bi = 0, si = 0;
  for (int i = 0; i < 4; i++) {
    float v = c[i];
    if (v > b) { s = b; si = bi; b = v; bi = i; } else if (v > s) { s = v; si = i; }
  }
  float d = b - s;
  vec3 col = uCol[bi];
  col *= 1.0 - 0.24 * (1.0 - smoothstep(0.0, 0.9, d));          // soft shade toward the front
  vec2 gw = vec2(hg.x, -hg.y) * uZoom;
  col *= 1.0 + 0.10 * clamp(dot(gw, vec2(-0.7, -0.7)) * 70.0, -1.0, 1.0);  // faint relief

  // frontline: constant-width line where the top two countries tie
  // (dFdx of d itself breaks at the tie, where the top-two pair swaps; the
  // derivative of the underlying field does not)
  vec4 cdx = dFdx(c), cdy = dFdy(c);   // derivatives of the whole (smooth) field, then pick this pixel's pair
  float dpx = d / max(length(vec2(cdx[bi] - cdx[si], cdy[bi] - cdy[si])), 1e-6);
  float lw = 1.0 + 0.7 * uZoom;
  col = mix(col, col * 1.22, (1.0 - smoothstep(lw + 0.5, lw + 4.0, dpx)) * 0.5);
  col = mix(col, vec3(0.05, 0.06, 0.08), (1.0 - smoothstep(lw - 0.8, lw + 0.8, dpx)) * 0.92);

  // provinces: px distance to the nearest province border, from the baked field
  vec2 et = texture(uEdge, uv).rg;
  float pe = et.r * uEdgeMax * uZoom;
  // terrain: hills are darker with a diagonal hatch, fortified ground is paler with a heavy border
  float hill = clamp(1.0 - abs(et.g - 0.5) * 4.0, 0.0, 1.0), fort = smoothstep(0.75, 0.95, et.g);
  float hz = abs(fract((w.x + w.y) / 9.0) - 0.5) * 9.0 * uZoom;
  col *= 1.0 - hill * (0.13 + 0.2 * (1.0 - smoothstep(0.4, 1.3, hz)));
  col = mix(col, vec3(1.0), 0.1 * fort);
  col = mix(col, vec3(0.03, 0.04, 0.06), (1.0 - smoothstep(1.5, 3.5, pe)) * 0.55 * fort);
  col = mix(col, vec3(0.03, 0.04, 0.06), (1.0 - smoothstep(0.3, 1.4, pe)) * 0.24);
  if (inProv(0, w)) {   // hovered
    col = mix(col, vec3(1.0), 0.10);
    col = mix(col, vec3(1.0), (1.0 - smoothstep(1.2, 3.2, pe)) * 0.6);
  }
  if (uFlashA > 0.0 && inProv(1, w)) col = mix(col, vec3(1.0), uFlashA * 0.45);

  vec3 outc = mix(sea, col, land);
  outc = mix(outc, vec3(0.04, 0.06, 0.09), (1.0 - smoothstep(0.8, 2.0, abs(hpx))) * 0.8);

  // graticule
  vec2 gq = abs(fract(w / 150.0 - 0.5) - 0.5) * 150.0 * uZoom;
  outc = mix(outc, vec3(1.0), (1.0 - smoothstep(0.4, 1.4, min(gq.x, gq.y))) * 0.045);

  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  outc *= 1.0 - 0.35 * dot(q, q);
  outColor = vec4(outc, 1.0);
}`;

  let gl, prog, uni = {}, ctlTex, mapCv, ovCv, ctx, dpr = 1, mapDpr = 1, mapCap = 1.5, W = 0, H = 0;
  let emaDt = 16, slow = 0, fast = 0;
  const sprites = [], labels = [], selP = new Float32Array(4), selR = new Float32Array(2), selN = new Float32Array(64);
  let lastSel = [];

  function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }

  function shader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  function makeTex(unit, ifmt, fmt, data) {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, GW, GH, 0, fmt, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  R.init = function (mapCanvas, overlayCanvas) {
    mapCv = mapCanvas; ovCv = overlayCanvas;
    gl = mapCv.getContext('webgl2', { antialias: false, alpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    ctx = ovCv.getContext('2d');

    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    for (const n of ['uCtl', 'uLand', 'uRes', 'uCam', 'uWorld', 'uGrid', 'uZoom', 'uTime', 'uCol', 'uEdge', 'uEdgeMax', 'uSelP', 'uSelR', 'uSelN', 'uSelCount', 'uFlashA']) uni[n] = gl.getUniformLocation(prog, n);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    ctlTex = makeTex(0, gl.RGBA, gl.RGBA, G.packCtl());
    makeTex(1, gl.R8, gl.RED, G.landTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    const edge = G.bakeEdges();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, edge.w, edge.h, 0, gl.RG, gl.UNSIGNED_BYTE, edge.data);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uni.uEdge, 2);
    gl.uniform1f(uni.uEdgeMax, G.EDGE_MAX);
    gl.uniform1i(uni.uCtl, 0);
    gl.uniform1i(uni.uLand, 1);
    gl.uniform2f(uni.uWorld, WORLD_W, WORLD_H);
    gl.uniform2f(uni.uGrid, GW, GH);
    gl.uniform3fv(uni.uCol, new Float32Array(G.COUNTRIES.flatMap(c => hexRgb(c.color))));

    G.COUNTRIES.forEach((c, k) => {
      sprites[k] = flagSprite(c.flag);
      labels[k] = { x: G.stats.cx[k], y: G.stats.cy[k], area: G.stats.area[k] };
    });
    R.resize();
  };

  R.resize = function () {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    ovCv.width = Math.round(W * dpr); ovCv.height = Math.round(H * dpr);
    mapCap = Math.min(dpr, 1.5); mapDpr = Math.min(mapDpr || mapCap, mapCap);
    sizeMap();
  };
  function sizeMap() {
    mapCv.width = Math.round(W * mapDpr); mapCv.height = Math.round(H * mapDpr);   // CSS stretches it to the window
    gl.viewport(0, 0, mapCv.width, mapCv.height);
  }
  // The map shader is the expensive part of a frame. If frames run long, shade
  // fewer pixels (the soft map hides it well); creep back up when there is headroom.
  function adaptResolution(dt) {
    emaDt += (dt * 1000 - emaDt) * 0.08;
    if (emaDt > 21) { fast = 0; if (++slow > 40 && mapDpr > 0.75) { mapDpr -= 0.25; slow = 0; sizeMap(); } }
    else if (emaDt < 13) { slow = 0; if (++fast > 300 && mapDpr < mapCap) { mapDpr = Math.min(mapCap, mapDpr + 0.25); fast = 0; sizeMap(); } }
    else slow = fast = 0;
  }
  R.mapScale = () => mapDpr;

  // Soft drop shadows, blurred once here and then stamped with drawImage
  // (a live ctx.shadowBlur re-blurs every flag every frame).
  function shadowSprite(round) {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = round ? 96 : 64;
    const c = cv.getContext('2d');
    c.filter = 'blur(5px)'; c.fillStyle = 'rgba(0,0,0,0.55)';
    c.beginPath();
    if (round) c.arc(48, 48, 30, 0, 6.2832); else c.rect(16, 10.7, 64, 42.6);   // the shape fills 2/3 of the sprite, the rest is room for the blur
    c.fill();
    return cv;
  }
  const shadowRect = shadowSprite(false), shadowDisc = shadowSprite(true);

  const NAME_PX = 96, nameSprites = {};
  function nameSprite(name) {
    if (nameSprites[name]) return nameSprites[name];
    const cv = document.createElement('canvas'), c = cv.getContext('2d'), font = `700 ${NAME_PX}px "Segoe UI", system-ui, sans-serif`;
    c.font = font; if ('letterSpacing' in c) c.letterSpacing = `${NAME_PX * 0.22}px`;
    cv.width = Math.ceil(c.measureText(name.toUpperCase()).width) + 8; cv.height = NAME_PX * 1.3;
    c.font = font; if ('letterSpacing' in c) c.letterSpacing = `${NAME_PX * 0.22}px`;   // resizing a canvas resets its state
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff';
    c.fillText(name.toUpperCase(), cv.width / 2 + NAME_PX * 0.11, cv.height / 2);
    return nameSprites[name] = cv;
  }

  function flagSprite(flag) {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 64;
    const c = cv.getContext('2d'), n = flag.stripes.length;
    c.beginPath(); c.roundRect ? c.roundRect(0, 0, 96, 64, 11) : c.rect(0, 0, 96, 64); c.clip();   // same corner radius the border is drawn with
    flag.stripes.forEach((col, i) => {
      c.fillStyle = col;
      if (flag.dir === 'v') c.fillRect(Math.floor(i * 96 / n), 0, Math.ceil(96 / n), 64);
      else c.fillRect(0, Math.floor(i * 64 / n), 96, Math.ceil(64 / n));
    });
    const g = c.createLinearGradient(0, 0, 0, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.22)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
    c.fillStyle = g; c.fillRect(0, 0, 96, 64);
    return cv;
  }

  function rr(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Swept-wing silhouette pointing along +x; k < 0 draws a plain shadow.
  function drawJet(x, y, h, s, k) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(h); ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(10, 0); ctx.lineTo(2, -2); ctx.lineTo(-3, -9); ctx.lineTo(-6, -9); ctx.lineTo(-3.5, -2);
    ctx.lineTo(-8, -1.5); ctx.lineTo(-10, -5); ctx.lineTo(-11.5, -5); ctx.lineTo(-10.5, 0);
    ctx.lineTo(-11.5, 5); ctx.lineTo(-10, 5); ctx.lineTo(-8, 1.5); ctx.lineTo(-3.5, 2); ctx.lineTo(-6, 9); ctx.lineTo(-3, 9); ctx.lineTo(2, 2);
    ctx.closePath();
    if (k < 0) { ctx.fillStyle = '#000'; ctx.fill(); }
    else {
      ctx.fillStyle = '#eef1f5'; ctx.fill();
      ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(-2, 0, 2.6, 0, 6.2832); ctx.fillStyle = G.COUNTRIES[k].color; ctx.fill();
    }
    ctx.restore();
  }

  R.FLAG_W = 22; R.FLAG_H = 14.5;
  R.unitScale = cam => clamp(0.55 + 0.45 * cam.zoom, 0.7, 1.5);
  // clamped: at t=0 float error makes this slightly negative, and a negative radius makes canvas throw
  const easeOutBack = t => Math.max(0.01, 1 + 2.2 * (t - 1) ** 3 + 1.2 * (t - 1) ** 2);

  // ui: { cam, time, dt, hover, box, order }
  R.draw = function (ui) {
    const cam = ui.cam;
    adaptResolution(ui.dt);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctlTex);
    if (ui.dirty !== false) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GW, GH, gl.RGBA, gl.UNSIGNED_BYTE, G.packCtl());   // only when the simulation moved
    gl.uniform2f(uni.uRes, mapCv.width, mapCv.height);
    gl.uniform2f(uni.uCam, cam.x, cam.y);
    gl.uniform1f(uni.uZoom, cam.zoom * mapDpr);
    gl.uniform1f(uni.uTime, ui.time);
    const sel = [ui.hoverProv, ui.flash && ui.flash.p];
    if (sel[0] !== lastSel[0] || sel[1] !== lastSel[1]) {
      lastSel = sel;
      selP.fill(0); selN.fill(0); selR.fill(0);
      sel.forEach((p, k) => { if (p) { selP[k * 2] = p.sx; selP[k * 2 + 1] = p.sy; selR[k] = p.reach; selN.set(p.nb.slice(0, 32), k * 32); } });
      gl.uniform2fv(uni.uSelP, selP);
      gl.uniform1fv(uni.uSelR, selR);
      gl.uniform2fv(uni.uSelN, selN);
      gl.uniform1iv(uni.uSelCount, sel.map(p => p ? Math.min(16, p.nb.length / 2) : 0));
    }
    gl.uniform1f(uni.uFlashA, ui.flash ? 1 - ui.flash.t / 0.45 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const sx = x => (x - cam.x) * cam.zoom + W / 2, sy = y => (y - cam.y) * cam.zoom + H / 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

    // --- country names, drifting with the territory centroid
    const k1 = 1 - Math.exp(-ui.dt * 2.5);
    G.COUNTRIES.forEach((c, k) => {
      const L = labels[k], s = G.stats;
      if (s.area[k] > 0) { L.x = lerp(L.x, s.cx[k], k1); L.y = lerp(L.y, s.cy[k], k1); }
      L.area = lerp(L.area, s.area[k], k1);
      const fs = Math.min(84, 0.55 * Math.sqrt(L.area) * CELL * cam.zoom / (c.name.length * 0.8));
      if (fs < 11) return;
      const spr = nameSprite(c.name), sc = fs / NAME_PX;
      ctx.globalAlpha = 0.26 * clamp((fs - 11) / 8, 0, 1);
      ctx.drawImage(spr, sx(L.x) - spr.width * sc / 2, sy(L.y) - spr.height * sc / 2, spr.width * sc, spr.height * sc);
      ctx.globalAlpha = 1;
    });
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

    // --- supply overlay (Tab): routes back to the sources, level per province, chokepoints
    if (ui.supply) {
      const COL = ['#ff5a5a', '#ffb84d', '#6fdc7a'];
      ctx.lineCap = 'round';
      for (const n of ui.supply.nodes) {
        if (!n.parent) continue;
        ctx.beginPath(); ctx.moveTo(sx(n.p.x), sy(n.p.y)); ctx.lineTo(sx(n.parent.x), sy(n.parent.y));
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(8,10,14,0.55)'; ctx.stroke();
        ctx.lineWidth = 2.5; ctx.strokeStyle = COL[n.level]; ctx.stroke();
      }
      ctx.lineCap = 'butt';
      for (const n of ui.supply.nodes) {
        const x = sx(n.p.x), y = sy(n.p.y);
        ctx.beginPath(); ctx.arc(x, y, n.source ? 8 : 5, 0, 6.2832);
        ctx.fillStyle = COL[n.level]; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
        if (n.source) { ctx.beginPath(); ctx.arc(x, y, 12, 0, 6.2832); ctx.lineWidth = 2; ctx.strokeStyle = COL[2]; ctx.stroke(); }
      }
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      for (const c of ui.supply.chokes) {
        const x = sx(c.p.x), y = sy(c.p.y), r = 15 + 2 * Math.sin(ui.time * 5);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.setLineDash([5, 4]); ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff5a5a'; ctx.stroke(); ctx.setLineDash([]);
        const label = `${c.n} at risk`, tw = ctx.measureText(label).width + 10;
        rr(x - tw / 2, y - 33, tw, 16, 4); ctx.fillStyle = 'rgba(120,20,20,0.92)'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(label, x, y - 24.5);
      }
    }

    // --- capitals
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
    G.caps.forEach((p, k) => {
      const x = sx(p.x), y = sy(p.y);
      ctx.beginPath(); ctx.arc(x, y, 5, 0, 6.2832);
      ctx.fillStyle = '#f4f1e6'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 6.2832); ctx.fillStyle = 'rgba(8,10,14,0.9)'; ctx.fill();
      const holder = G.cityOwner(k);   // a captured capital wears its holder's colour
      if (holder >= 0 && holder !== k) { ctx.beginPath(); ctx.arc(x, y, 8.5, 0, 6.2832); ctx.lineWidth = 2.5; ctx.strokeStyle = G.COUNTRIES[holder].color; ctx.stroke(); }
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,10,14,0.7)'; ctx.strokeText(G.COUNTRIES[k].capital, x, y + 15);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(G.COUNTRIES[k].capital, x, y + 15);
    });

    // --- capitals under occupation: red countdown ring
    G.caps.forEach((p, k) => {
      if (G.occupy[k] <= 0) return;
      const x = sx(p.x), y = sy(p.y), pulse = 0.6 + 0.4 * Math.sin(ui.time * 8);
      ctx.beginPath(); ctx.arc(x, y, 13, 0, 6.2832); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,10,14,0.7)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 13, -1.5708, -1.5708 + 6.2832 * G.occupy[k]);
      ctx.lineWidth = 3; ctx.strokeStyle = `rgba(255,70,70,${pulse})`; ctx.stroke();
    });

    // --- gaps in the player's front: pulsing warning on undefended border provinces
    for (const p of ui.gaps || []) {
      const x = sx(p.x), y = sy(p.y), a = 0.55 + 0.45 * Math.sin(ui.time * 6);
      ctx.beginPath(); ctx.moveTo(x, y - 11); ctx.lineTo(x + 10, y + 7); ctx.lineTo(x - 10, y + 7); ctx.closePath();
      ctx.fillStyle = '#ff4d4d'; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y + 1, 14 + 6 * a, 0, 6.2832); ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,77,77,${0.9 - 0.7 * a})`; ctx.stroke();
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('!', x, y + 1);
    }

    // --- provinces the selection has been ordered to take/hold
    const marked = new Set();
    for (const u of G.units) if (u.sel) for (const id of u.holdIds) marked.add(id);
    for (const id of marked) {
      const q = G.provinces.get(id), x = sx(q.x), y = sy(q.y);
      ctx.beginPath(); ctx.arc(x, y, 11, 0, 6.2832); ctx.fillStyle = 'rgba(14,20,28,0.75)'; ctx.fill();
      ctx.setLineDash([4, 3]); ctx.lineDashOffset = -ui.time * 8; ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('\u2694', x, y + 0.5);
    }

    // --- move orders of the selection
    ctx.lineWidth = 1.5; ctx.setLineDash([6, 6]); ctx.lineDashOffset = -ui.time * 24;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const u of G.units) {
      if (!u.sel || !u.hasTarget) continue;
      ctx.beginPath(); ctx.moveTo(sx(u.x), sy(u.y));
      for (const q of u.path || []) ctx.lineTo(sx(q.x), sy(q.y));
      if (!u.blocked) ctx.lineTo(sx(u.tx), sy(u.ty));
      ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(u.tx), sy(u.ty), 3, 0, 6.2832); ctx.fill();
    }
    ctx.setLineDash([]);

    // --- paused: lay out what everybody is doing - movement, attacks, fights, guns
    if (ui.paused) {
      const arrow = (x0, y0, x1, y1, col, wd, head) => {
        const a = Math.atan2(y1 - y0, x1 - x0);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.lineWidth = wd + 2; ctx.strokeStyle = 'rgba(8,10,14,0.65)'; ctx.stroke();
        ctx.lineWidth = wd; ctx.strokeStyle = col; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x1 - Math.cos(a - 0.45) * head, y1 - Math.sin(a - 0.45) * head); ctx.lineTo(x1 - Math.cos(a + 0.45) * head, y1 - Math.sin(a + 0.45) * head); ctx.closePath();
        ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(8,10,14,0.8)'; ctx.stroke();
      };
      const attacks = new Map();   // province -> attackers by country
      for (const u of G.units) {
        const mine = u.k === G.player, col = mine ? '#ffffff' : G.COUNTRIES[u.k].color;
        if (u.hasTarget && Math.hypot(u.tx - u.x, u.ty - u.y) > 14) {   // where it is going (its real route)
          const pts = [[u.x, u.y]].concat((u.path || []).map(q => [q.x, q.y]), u.blocked ? [] : [[u.tx, u.ty]]);
          ctx.beginPath(); ctx.moveTo(sx(pts[0][0]), sy(pts[0][1]));
          for (let i = 1; i < pts.length - 1; i++) ctx.lineTo(sx(pts[i][0]), sy(pts[i][1]));
          ctx.lineWidth = mine ? 2 : 1.5; ctx.strokeStyle = col; ctx.globalAlpha = mine ? 0.9 : 0.75; ctx.stroke();
          const n = pts.length;
          if (n > 1) arrow(sx(pts[n - 2][0]), sy(pts[n - 2][1]), sx(pts[n - 1][0]), sy(pts[n - 1][1]), col, mine ? 2 : 1.5, 8);
          ctx.globalAlpha = 1;
        }
        if (u.pushing && u.prov >= 0 && G.provinces.has(u.prov)) {   // what it is attacking
          const q = G.provinces.get(u.prov), d = Math.hypot(q.x - u.x, q.y - u.y) || 1, L = Math.min(34, d * cam.zoom);
          arrow(sx(u.x), sy(u.y), sx(u.x) + (q.x - u.x) / d * L, sy(u.y) + (q.y - u.y) / d * L, '#ff6a4d', 3, 9);
          let m = attacks.get(u.prov); if (!m) attacks.set(u.prov, m = new Map());
          m.set(u.k, (m.get(u.k) || 0) + 1);
        }
      }
      // who is fighting whom
      ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,90,70,0.85)'; ctx.setLineDash([2, 3]);
      const fr2 = G.TUNE.fightRange ** 2;
      for (let i = 0; i < G.units.length; i++) for (let j = i + 1; j < G.units.length; j++) {
        const a = G.units[i], b = G.units[j];
        if (a.k === b.k || (a.x - b.x) ** 2 + (a.y - b.y) ** 2 > fr2) continue;
        ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
      }
      ctx.setLineDash([]);
      // provinces under attack, ringed in the attackers' colours
      ctx.font = '700 11px "Segoe UI", system-ui, sans-serif';
      for (const [id, m] of attacks) {
        const q = G.provinces.get(id), x = sx(q.x), y = sy(q.y);
        let r = 11, total = 0;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fillStyle = 'rgba(14,20,28,0.9)'; ctx.fill();
        for (const [k, n] of m) { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.lineWidth = 3; ctx.strokeStyle = G.COUNTRIES[k].color; ctx.stroke(); r += 3.5; total += n; }
        ctx.fillStyle = '#fff'; ctx.fillText('\u2694' + (total > 1 ? total : ''), x, y + 0.5);
      }
      // your guns: reach and current aim
      for (const b of G.buildings) {
        if (b.k !== G.player || b.type !== 'artillery') continue;
        const A = G.BUILDINGS.artillery, x = sx(b.x), y = sy(b.y);
        ctx.beginPath(); ctx.arc(x, y, A.range * cam.zoom, 0, 6.2832); ctx.setLineDash([5, 5]); ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.stroke(); ctx.setLineDash([]);
        arrow(x, y, x + Math.cos(b.aim) * 46, y + Math.sin(b.aim) * 46, '#ffd27a', 2, 8);
      }
    }

    // --- clashes
    for (const c of G.clashes) {
      const f = 0.5 + 0.5 * Math.sin(ui.time * 22 + c.id), r = 4 + 5 * f, x = sx(c.x), y = sy(c.y);
      ctx.fillStyle = `rgba(255,214,130,${0.35 + 0.55 * f})`;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) { const a = i * 0.7854 + c.id, q = i % 2 ? r * 0.35 : r; ctx.lineTo(x + Math.cos(a) * q, y + Math.sin(a) * q); }
      ctx.fill();
    }

    const us = R.unitScale(cam);

    // --- buildings
    const drawBuilding = (type, k, x, y, s, aim, alpha) => {
      const r = 9 * s;
      ctx.globalAlpha = alpha;
      ctx.drawImage(shadowDisc, x - r * 1.6, y - r * 1.6 + 1.5, r * 3.2, r * 3.2);
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fillStyle = '#161b22'; ctx.fill();
      ctx.lineWidth = 2 * s; ctx.strokeStyle = G.COUNTRIES[k].color; ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle = '#eef1f5'; ctx.lineCap = 'round';
      if (type === 'artillery') {
        ctx.lineWidth = 2.4 * s;
        ctx.beginPath(); ctx.moveTo(x - Math.cos(aim) * 2 * s, y - Math.sin(aim) * 2 * s);
        ctx.lineTo(x + Math.cos(aim) * 7.5 * s, y + Math.sin(aim) * 7.5 * s); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 3 * s, 0, 6.2832); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(x - 5.5 * s, y - 0.5 * s); ctx.lineTo(x, y - 5.5 * s); ctx.lineTo(x + 5.5 * s, y - 0.5 * s); ctx.closePath(); ctx.fill();
        ctx.fillRect(x - 4 * s, y - 0.5 * s, 8 * s, 5 * s);
        ctx.fillStyle = '#161b22'; ctx.fillRect(x - 1.2 * s, y + 1.2 * s, 2.4 * s, 3.3 * s);
      }
      ctx.lineCap = 'butt'; ctx.globalAlpha = 1;
    };
    for (const b of G.buildings) {
      const x = sx(b.x), y = sy(b.y), s = us * easeOutBack(Math.min(1, b.age / 0.35));
      if (x < -60 || y < -60 || x > W + 60 || y > H + 60) continue;
      drawBuilding(b.type, b.k, x, y, s, b.aim, 1);
      if (b.type === 'artillery') {   // reload sweep
        const A = G.BUILDINGS.artillery, f = 1 - G.clamp(b.cool / A.reload, 0, 1);
        ctx.beginPath(); ctx.arc(x, y, 12 * s, -1.5708, -1.5708 + 6.2832 * f);
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke();
        if (b === ui.hoverB) {
          ctx.beginPath(); ctx.arc(x, y, A.range * cam.zoom, 0, 6.2832);
          ctx.setLineDash([5, 5]); ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.stroke(); ctx.setLineDash([]);
        }
      } else if (!b.linked) {
        const f = b.stock / G.SUPPLY.depot;
        rr(x - 11, y + 12 * s, 22, 5, 2.5); ctx.fillStyle = 'rgba(8,10,14,0.8)'; ctx.fill();
        rr(x - 10, y + 12 * s + 1, Math.max(2, 20 * f), 3, 1.5); ctx.fillStyle = f > 0 ? '#ffb84d' : '#ff5a5a'; ctx.fill();
      } else if (b === ui.hoverB) {
        ctx.beginPath(); ctx.arc(x, y, 12 * s, 0, 6.2832); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.stroke();
      }
    }
    // where the player's new divisions appear
    const mp = !ui.replaying && G.player >= 0 && G.musterPoint(G.player);
    if (mp) {
      const x = sx(mp.x), y = sy(mp.y), pr = 15 * us + 2 * Math.sin(ui.time * 3);
      ctx.beginPath(); ctx.arc(x, y, pr, 0, 6.2832);
      ctx.setLineDash([4, 4]); ctx.lineDashOffset = -ui.time * 10; ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- units
    const sorted = G.units.slice().sort((a, b) => a.y - b.y);
    for (const u of sorted) {
      const s = us * easeOutBack(Math.min(1, u.age / 0.35));
      const w = R.FLAG_W * s, h = R.FLAG_H * s, x = sx(u.x) - w / 2, y = sy(u.y) - h / 2;
      if (x > W + 40 || y > H + 40 || x < -80 || y < -80) continue;
      if (u.sel) {
        ctx.beginPath(); ctx.ellipse(sx(u.x), sy(u.y) + h * 0.2, w * 0.85, h * 0.85, 0, 0, 6.2832);
        ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
        ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.stroke();
      }
      ctx.drawImage(shadowRect, x - w * 0.25, y - h * 0.25 + 1.5, w * 1.5, h * 1.5);
      rr(x, y, w, h, 2.5 * s); ctx.fillStyle = '#111'; ctx.fill();
      ctx.drawImage(sprites[u.k], x, y, w, h);
      rr(x, y, w, h, 2.5 * s);
      if (u.sel) { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; }
      else if (u === ui.hover) { ctx.lineWidth = 1.75; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; }
      else { ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; }
      ctx.stroke();
      if (u.mode === 'front') {   // holding the front: small shield tab under the flag
        const bx2 = x + w / 2, by2 = y + h + 8.5;
        ctx.beginPath(); ctx.moveTo(bx2 - 4, by2 - 2.5); ctx.lineTo(bx2 + 4, by2 - 2.5); ctx.lineTo(bx2 + 4, by2 + 1); ctx.lineTo(bx2, by2 + 4.5); ctx.lineTo(bx2 - 4, by2 + 1); ctx.closePath();
        ctx.fillStyle = '#dfe6ee'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      }
      if (u.type === 'guard' && u.k === G.player && !ui.replaying) {   // reach of the guard's steadying effect
        ctx.beginPath(); ctx.arc(sx(u.x), sy(u.y), G.GUARD_AURA.range * cam.zoom, 0, 6.2832);
        ctx.setLineDash([3, 6]); ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(242,201,76,0.4)'; ctx.stroke(); ctx.setLineDash([]);
      }
      if (u.type === 'guard') {
        rr(x - 1.75, y - 1.75, w + 3.5, h + 3.5, 3.5 * s); ctx.lineWidth = 1.75; ctx.strokeStyle = '#f2c94c'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + w / 2, y - 6.5 * s); ctx.lineTo(x + w / 2 + 3.2 * s, y - 2 * s); ctx.lineTo(x + w / 2, y + 1 * s); ctx.lineTo(x + w / 2 - 3.2 * s, y - 2 * s); ctx.closePath();
        ctx.fillStyle = '#f2c94c'; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      }
      if (u.dig > 0.05) {   // dug in: dashed earthwork around the flag
        rr(x - 2.5, y - 2.5, w + 5, h + 5, 4 * s);
        ctx.setLineDash([3, 2]); ctx.lineWidth = 1.5; ctx.strokeStyle = `rgba(240,228,190,${0.95 * u.dig})`; ctx.stroke();
        ctx.setLineDash([]);
      }
      if (u.sup < 2) {   // short of supply: amber = strained, pulsing red = cut off
        const bx3 = x - 1, by3 = y - 1, br = 4.6 * s * (u.sup ? 1 : 1 + 0.18 * Math.sin(ui.time * 8));
        ctx.beginPath(); ctx.arc(bx3, by3, br, 0, 6.2832);
        ctx.fillStyle = u.sup ? '#ffb84d' : '#ff4d4d'; ctx.fill(); ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(bx3 - br * 0.5, by3 + br * 0.5); ctx.lineTo(bx3 + br * 0.5, by3 - br * 0.5);
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      }
      if (u.bonus) {   // top-right: arrow = pushing with a bonus (red, down = at a penalty), shield = holding with a bonus
        const cx2 = x + w + 1, cy2 = y - 1, r2 = 5 * s, strong = u.bonusAmt >= 1.6;
        ctx.beginPath(); ctx.arc(cx2, cy2, r2 + 1.2, 0, 6.2832); ctx.fillStyle = 'rgba(8,10,14,0.9)'; ctx.fill();
        ctx.beginPath();
        if (u.bonus === 2) {
          ctx.moveTo(cx2 - r2 * 0.75, cy2 - r2 * 0.7); ctx.lineTo(cx2 + r2 * 0.75, cy2 - r2 * 0.7); ctx.lineTo(cx2 + r2 * 0.75, cy2 + r2 * 0.05);
          ctx.lineTo(cx2, cy2 + r2 * 0.85); ctx.lineTo(cx2 - r2 * 0.75, cy2 + r2 * 0.05);
          ctx.fillStyle = strong ? '#f2c94c' : '#cfd8e3';
        } else {
          const dn = u.bonus < 0 ? -1 : 1;   // arrow up, or flipped for a penalty
          ctx.moveTo(cx2, cy2 - r2 * 0.85 * dn); ctx.lineTo(cx2 + r2 * 0.8, cy2 + r2 * 0.05 * dn); ctx.lineTo(cx2 + r2 * 0.3, cy2 + r2 * 0.05 * dn);
          ctx.lineTo(cx2 + r2 * 0.3, cy2 + r2 * 0.8 * dn); ctx.lineTo(cx2 - r2 * 0.3, cy2 + r2 * 0.8 * dn); ctx.lineTo(cx2 - r2 * 0.3, cy2 + r2 * 0.05 * dn); ctx.lineTo(cx2 - r2 * 0.8, cy2 + r2 * 0.05 * dn);
          ctx.fillStyle = u.bonus < 0 ? '#ff5a5a' : strong ? '#f2c94c' : '#6fdc7a';
        }
        ctx.closePath(); ctx.fill();
      }
      if (u.falling || u.blocked) {   // bottom-right: falling back / can't get there
        ctx.font = `700 ${Math.round(10 * s)}px "Segoe UI", system-ui, sans-serif`;
        const cx3 = x + w + 1, cy3 = y + h;
        ctx.beginPath(); ctx.arc(cx3, cy3, 5.5 * s, 0, 6.2832); ctx.fillStyle = u.blocked ? 'rgba(120,20,20,0.95)' : 'rgba(8,10,14,0.9)'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(u.blocked ? '\u00d7' : '\u21a9', cx3, cy3 + 0.5);
      }
      if (ui.paused && u.k === G.player) {   // what this division is doing, in words
        const act = u.falling ? 'falling back' : u.sup === 0 ? 'cut off' : u.blocked ? 'cannot get there' : u.pushing ? (u.stance === 'assault' ? 'assaulting' : u.stance === 'probe' ? 'probing' : 'attacking')
          : u.hasTarget ? (u.guard ? 'moving to guard' : 'moving') : u.guard ? 'guarding' : u.mode === 'front' ? 'holding the front' : u.stance === 'hold' ? 'holding' : u.dig > 0.5 ? 'dug in' : u.fighting ? 'defending' : 'idle';
        ctx.font = '600 9.5px "Segoe UI", system-ui, sans-serif';
        const tw = ctx.measureText(act).width + 8, ty = y + h + 13;
        rr(sx(u.x) - tw / 2, ty - 6.5, tw, 13, 3); ctx.fillStyle = u.falling || u.sup === 0 ? 'rgba(120,20,20,0.92)' : 'rgba(8,10,14,0.85)'; ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(act, sx(u.x), ty + 0.5);
      }
      // strength
      const bw = w * 0.9, bx = sx(u.x) - bw / 2, by = y + h + 2.5;
      rr(bx - 1, by - 1, bw + 2, 5, 2.5); ctx.fillStyle = 'rgba(8,10,14,0.8)'; ctx.fill();
      rr(bx, by, Math.max(3, bw * u.str), 3, 1.5);
      ctx.fillStyle = `hsl(${Math.round(u.str * 115)},70%,52%)`; ctx.fill();
    }

    // --- shells in flight: ground shadow + lobbed round with a short trail
    for (const sh of G.shells) {
      const at = f => { const q = G.clamp(f, 0, 1), lift = sh.fast ? 14 * (1 - q) * cam.zoom : Math.sin(q * Math.PI) * Math.hypot(sh.x - sh.x0, sh.y - sh.y0) * 0.22 * cam.zoom;
        return { x: sx(lerp(sh.x0, sh.x, q)), gy: sy(lerp(sh.y0, sh.y, q)), lift }; };
      const f = sh.t / sh.life, p = at(f), q = at(f - 0.08);
      ctx.beginPath(); ctx.arc(p.x, p.gy, 2, 0, 6.2832); ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.fill();
      ctx.beginPath(); ctx.moveTo(q.x, q.gy - q.lift); ctx.lineTo(p.x, p.gy - p.lift);
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,220,150,0.6)'; ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.gy - p.lift, 2.4, 0, 6.2832); ctx.fillStyle = '#fff3d6'; ctx.fill();
    }

    // --- air marker (player's): crosshair + operating radius
    const mark = !ui.replaying && G.player >= 0 && G.airMark[G.player];
    const drawMark = (x, y, alpha) => {
      const R = G.JET.range * cam.zoom;
      ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(x, y, R, 0, 6.2832);
      ctx.fillStyle = 'rgba(255,255,255,0.04)'; ctx.fill();
      ctx.setLineDash([6, 6]); ctx.lineDashOffset = ui.time * 8; ctx.lineWidth = 1.25; ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.stroke(); ctx.setLineDash([]);
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 6.2832);
      for (let i = 0; i < 4; i++) { const a = i * 1.5708; ctx.moveTo(x + Math.cos(a) * 4, y + Math.sin(a) * 4); ctx.lineTo(x + Math.cos(a) * 12, y + Math.sin(a) * 12); }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (mark) drawMark(sx(mark.x), sy(mark.y), 0.9);
    if (ui.build === 'airmark' && ui.mouse) drawMark(sx(ui.mouse.x), sy(ui.mouse.y), 0.6);

    // --- jets: contrail, ground shadow, then the aircraft itself
    for (const j of G.jets) {
      const x = sx(j.x), y = sy(j.y), s = us * 1.15;
      if (j.state === 'ground') {   // parked beside the capital with a rearm ring
        const gx = x + 16, gy = y - 12, f = 1 - G.clamp(j.timer / G.JET.rearm, 0, 1);
        ctx.beginPath(); ctx.arc(gx, gy, 8, 0, 6.2832); ctx.fillStyle = 'rgba(14,20,28,0.85)'; ctx.fill();
        ctx.beginPath(); ctx.arc(gx, gy, 8, -1.5708, -1.5708 + 6.2832 * f); ctx.lineWidth = 2; ctx.strokeStyle = G.COUNTRIES[j.k].color; ctx.stroke();
        drawJet(gx, gy, -0.7854, s * 0.6, j.k);
        continue;
      }
      const tr = j.trail;
      for (let i = 2; i < tr.length; i += 2) {
        ctx.beginPath(); ctx.moveTo(sx(tr[i - 2]), sy(tr[i - 1]) - 10 * cam.zoom); ctx.lineTo(sx(tr[i]), sy(tr[i + 1]) - 10 * cam.zoom);
        ctx.lineWidth = 1 + 2 * i / tr.length; ctx.strokeStyle = `rgba(255,255,255,${0.45 * i / tr.length})`; ctx.stroke();
      }
      ctx.globalAlpha = 0.28; drawJet(x + 3, y + 5, j.h, s * 0.9, -1); ctx.globalAlpha = 1;
      drawJet(x, y - 10 * cam.zoom, j.h, s, j.k);
    }

    // --- effects
    for (const e of G.effects) {
      const t = e.t / e.life, x = sx(e.x), y = sy(e.y);
      if (e.type === 'surrender') {
        const yy = y - 22 * t;
        ctx.globalAlpha = 1 - t * t;
        ctx.beginPath(); ctx.moveTo(x - 5, yy + 9); ctx.lineTo(x - 5, yy - 9); ctx.lineWidth = 1.75; ctx.strokeStyle = 'rgba(8,10,14,0.95)'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 5, yy - 9); ctx.lineTo(x + 8, yy - 6 + Math.sin(ui.time * 9) * 1.2); ctx.lineTo(x - 5, yy - 1); ctx.closePath();
        ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1; ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (e.type === 'blast') {
        const r = e.r * cam.zoom * (0.55 + 0.45 * (1 - (1 - t) ** 3));
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
        ctx.globalAlpha = 0.55 * (1 - t); ctx.fillStyle = t < 0.15 ? '#fff' : G.COUNTRIES[e.k].color; ctx.fill(); ctx.globalAlpha = 1;
        ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,225,170,${1 - t})`; ctx.stroke();
      } else if (e.type === 'ping') {
        ctx.beginPath(); ctx.arc(x, y, 4 + 16 * t, 0, 6.2832);
        ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,255,255,${0.9 * (1 - t)})`; ctx.stroke();
      } else {
        const s = us * (1 + 0.6 * t), w = R.FLAG_W * s, h = R.FLAG_H * s;
        ctx.globalAlpha = (1 - t) * 0.8; ctx.drawImage(sprites[e.k], x - w / 2, y - h / 2, w, h); ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(x, y, 10 + 30 * t, 0, 6.2832);
        ctx.lineWidth = 2; ctx.strokeStyle = `rgba(255,200,120,${1 - t})`; ctx.stroke();
      }
    }

    // --- build placement ghost
    if (ui.build && ui.build !== 'airmark' && ui.mouse) {
      const x = sx(ui.mouse.x), y = sy(ui.mouse.y), def = G.BUILDINGS[ui.build];
      const ok = G.canBuild(G.player, ui.mouse.x, ui.mouse.y) && G.money[G.player] >= def.cost;
      if (def.range) {
        ctx.beginPath(); ctx.arc(x, y, def.range * cam.zoom, 0, 6.2832);
        ctx.fillStyle = ok ? 'rgba(255,255,255,0.05)' : 'rgba(255,90,90,0.05)'; ctx.fill();
        ctx.setLineDash([5, 5]); ctx.lineWidth = 1.25; ctx.strokeStyle = ok ? 'rgba(255,255,255,0.6)' : 'rgba(255,110,110,0.6)'; ctx.stroke(); ctx.setLineDash([]);
      }
      drawBuilding(ui.build, G.player, x, y, us, -0.6, ok ? 0.85 : 0.4);
      if (!ok) { ctx.beginPath(); ctx.arc(x, y, 12 * us, 0, 6.2832); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,90,90,0.9)'; ctx.stroke(); }
    }

    // --- drag feedback
    if (ui.box) {
      const b = ui.box, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1);
      ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1;
      ctx.fillRect(x, y, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (ui.order) {
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.setLineDash([3, 5]);
      ctx.beginPath(); ctx.moveTo(sx(ui.order[0].x), sy(ui.order[0].y));
      ctx.lineTo(sx(ui.order[ui.order.length - 1].x), sy(ui.order[ui.order.length - 1].y)); ctx.stroke();
      ctx.setLineDash([]);
      for (const p of ui.order) {
        ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 5, 0, 6.2832);
        ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(8,10,14,0.9)'; ctx.stroke();
      }
    }
  };
})();
