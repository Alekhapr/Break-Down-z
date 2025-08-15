
(() => {
  // ---------- CONFIG / TUNABLES -------------------------------------------
  const CONFIG = {
    BASE_WIDTH: 960,
    BASE_HEIGHT: 540,
    ASPECT: 16/9,
    // Paddle / ball base settings (will be adjusted for portrait)
    PADDLE: { w: 120, h: 16, speed: 820 },
    BALL: { r: 8, speed: 420, maxSpeed: 1200 },
    BRICK: { gap: 8, top: 72, marginX: 28, maxHeightRatio: 0.45, maxH: 32 },
    POWERUP: {
      fallSpeed: 160,      // px/sec
      chance: 0.22,       // chance a destroyed brick spawns a powerup (if brick isn't special)
      duration: 10,       // seconds for temporary powerups
    },
    LASER: { cooldown: 0.12, bulletSpeed: 820, life: 3.8 }, // seconds laser lasts
    MULTIBALL: { clones: 2 }, // spawn 2 extras (so total 3)
    MOBILE: {
      breakpoint: 768,
      portraitPaddleScale: 1.6,
      portraitBallScale: 0.85,
      portraitSpeedMul: 0.9
    }
  };

  // ---------- DOM & CANVAS ------------------------------------------------
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const ui = {
    score: document.getElementById('score'),
    lives: document.getElementById('lives'),
    levelNum: document.getElementById('level'),
    levelName: document.getElementById('levelName'),
    start: document.getElementById('btnStart'),
    reset: document.getElementById('btnReset'),
    speed: document.getElementById('speedSlider'),
    levelSelect: document.getElementById('levelSelect'),
    leftBtn: document.getElementById('leftBtn'),
    rightBtn: document.getElementById('rightBtn'),
    launchBtn: document.getElementById('launchBtn'),
  };

  // ---------- AUDIO (tiny beeps) ------------------------------------------
  const audio = (() => {
    let actx;
    function beep(freq=640, dur=0.06, type='sine', vol=0.06) {
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const o = actx.createOscillator();
        const g = actx.createGain();
        o.type = type; o.frequency.value = freq;
        g.gain.value = vol;
        o.connect(g); g.connect(actx.destination);
        o.start(); o.stop(actx.currentTime + dur);
      } catch { /* ignore */ }
    }
    return {
      paddle: () => beep(460, 0.05, 'sawtooth', 0.05),
      wall:   () => beep(720, 0.04, 'square', 0.04),
      brick:  () => beep(780, 0.04, 'triangle', 0.05),
      power:  () => beep(980, 0.06, 'triangle', 0.06),
      lose:   () => beep(240, 0.24, 'sine', 0.09),
      win:    () => beep(980, 0.24, 'sine', 0.08),
      start:  () => beep(880, 0.06, 'sine', 0.06),
      pause:  () => beep(200, 0.05, 'sine', 0.04)
    };
  })();

  // ---------- INPUT -------------------------------------------------------
  const keys = new Set();
  window.addEventListener('keydown', e => {
    if (['Space','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  function bindHold(btn, code) {
    if (!btn) return;
    const add = (e) => { e.preventDefault(); keys.add(code); };
    const rem = (e) => { e.preventDefault(); keys.delete(code); };
    btn.addEventListener('touchstart', add, {passive:false}); btn.addEventListener('mousedown', add);
    btn.addEventListener('touchend', rem); btn.addEventListener('mouseup', rem);
    btn.addEventListener('mouseleave', rem); btn.addEventListener('touchcancel', rem);
  }
  bindHold(ui.leftBtn, 'ArrowLeft');
  bindHold(ui.rightBtn, 'ArrowRight');
  if (ui.launchBtn) {
    ui.launchBtn.addEventListener('click', () => tryLaunch());
    ui.launchBtn.addEventListener('touchend', (e) => { e.preventDefault(); tryLaunch(); });
  }

  // Drag-to-move paddle
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => { dragging = true; movePaddleToEvent(e); });
  window.addEventListener('pointerup', () => dragging = false);
  canvas.addEventListener('pointermove', (e) => { if (dragging) movePaddleToEvent(e); });
  function movePaddleToEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (canvas.width / rect.width);
    state.paddle.x = clamp(x - state.paddle.w/2, 0, canvas.width - state.paddle.w);
  }

  // ---------- HELPERS -----------------------------------------------------
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rand = (min, max) => Math.random() * (max - min) + min;
  const nowSec = () => performance.now() / 1000;

  // ---------- GAME STATE --------------------------------------------------
  const state = {
    running: false,
    speedMul: 1,
    levelIndex: 0,
    levels: [],
    score: 0,
    lives: 3,
    paddle: { x: 0, y: 0, w: CONFIG.PADDLE.w, h: CONFIG.PADDLE.h, vx: 0 },
    balls: [], // array of ball objects {x,y,vx,vy,r,speed,stuck}
    bricks: [],
    powerups: [], // falling powerups {x,y,w,h,type,vy}
    bullets: [],  // laser bullets {x,y,vx,vy}
    timers: { widenEnd:0, shrinkEnd:0, laserEnd:0 },
    last: performance.now(),
    portraitMode: false,
  };

  // ---------- LEVEL LOADING (external JSON with inline fallback) ----------
  async function loadLevels() {
    try {
      const res = await fetch('levels.json', {cache:'no-store'});
      if (!res.ok) throw new Error('failed fetch');
      const data = await res.json();
      state.levels = normalizeLevels(data.levels || []);
      return;
    } catch (e) {
      // inline fallback (from HTML script#inline-levels)
      const inline = document.getElementById('inline-levels');
      if (inline) {
        try {
          const data = JSON.parse(inline.textContent);
          state.levels = normalizeLevels(data.levels || []);
          return;
        } catch {}
      }
      // final tiny fallback
      state.levels = normalizeLevels([{
        name:'Fallback', rows:6, cols:12,
        grid:[
          '111111111111',
          '122222222221',
          '133333333331',
          '144444444441',
          '100000000001',
          '111111111111'
        ]
      }]);
    }
  }

  function normalizeLevels(levels) {
    return (levels || []).map(L => {
      const grid = (L.grid || []).slice();
      const rows = L.rows ?? grid.length;
      const cols = L.cols ?? (grid[0]?.length ?? 0);
      while (grid.length < rows) grid.push('0'.repeat(cols));
      const normGrid = grid.map(r => r.padEnd(cols,'0').slice(0,cols));
      return { name: L.name || 'Level', rows, cols, grid: normGrid };
    });
  }

  function populateLevelSelect() {
    if (!ui.levelSelect) return;
    ui.levelSelect.innerHTML = '';
    state.levels.forEach((lvl, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx); opt.textContent = `${idx+1}. ${lvl.name}`;
      ui.levelSelect.appendChild(opt);
    });
    ui.levelSelect.value = String(state.levelIndex);
  }

  // ---------- BUILD BRICKS FROM GRID --------------------------------------
  function buildBricksFromGrid() {
    const L = state.levels[state.levelIndex];
    if (!L) { state.bricks = []; return; }
    const marginX = CONFIG.BRICK.marginX;
    const gap = CONFIG.BRICK.gap;
    const cols = L.cols, rows = L.rows;

    const totalGapX = (cols - 1) * gap;
    const availableW = canvas.width - marginX*2 - totalGapX;
    const bw = Math.max(12, Math.floor(availableW / Math.max(1, cols)));

    const totalGapY = (rows - 1) * gap;
    const maxBrickArea = Math.floor(canvas.height * CONFIG.BRICK.maxHeightRatio);
    const bh = Math.min(Math.floor((maxBrickArea - totalGapY)/Math.max(1, rows)), CONFIG.BRICK.maxH);

    const totalW = cols * bw + totalGapX;
    const x0 = Math.floor((canvas.width - totalW) / 2);
    const y0 = CONFIG.BRICK.top;

    const out = [];
    for (let r=0;r<rows;r++) {
      const rowStr = L.grid[r] || ''.padEnd(cols,'0');
      for (let c=0;c<cols;c++) {
        const ch = rowStr[c] || '0';
        if (ch === '0') continue;
        // digits 1..9 are HP; letters have special meanings:
        // M = multiball, W = widen, S = shrink, L = laser, X = steel (unbreakable)
        let hp = 0;
        let kind = 'normal';
        if (/[1-9]/.test(ch)) { hp = parseInt(ch,10); }
        else if (ch === 'X') { hp = 9999; kind = 'steel'; }
        else { // letters
          hp = 1;
          kind = ch; // 'M', 'W', 'S', 'L', etc.
        }
        out.push({
          x: x0 + c*(bw+gap),
          y: y0 + r*(bh+gap),
          w: bw, h: bh, hp, alive: true, kind
        });
      }
    }
    state.bricks = out;
  }

  // ---------- PADDLE / BALL / RESET ---------------------------------------
  function resetPaddleAndBalls() {
    // portrait adjustments
    if (state.portraitMode) {
      state.paddle.w = CONFIG.PADDLE.w * CONFIG.MOBILE.portraitPaddleScale;
      state.paddle.h = CONFIG.PADDLE.h;
    } else {
      state.paddle.w = CONFIG.PADDLE.w;
      state.paddle.h = CONFIG.PADDLE.h;
    }
    state.paddle.x = (canvas.width - state.paddle.w)/2;
    state.paddle.y = canvas.height - 42 - state.paddle.h;

    // single initial ball
    const r = Math.max(6, Math.round(CONFIG.BALL.r * (state.portraitMode ? CONFIG.MOBILE.portraitBallScale : 1)));
    const speedBase = CONFIG.BALL.speed * (state.portraitMode ? CONFIG.MOBILE.portraitSpeedMul : 1);
    state.balls = [{
      x: state.paddle.x + state.paddle.w/2,
      y: state.paddle.y - r - 1,
      vx: 0, vy: -speedBase * 0.9,
      r, speed: speedBase, stuck: true
    }];
    // clear powerups/bullets/timers
    state.powerups = [];
    state.bullets = [];
    state.timers.widenEnd = 0;
    state.timers.shrinkEnd = 0;
    state.timers.laserEnd = 0;
  }

  function startLevel(idx, keepStats=true) {
    state.levelIndex = clamp(idx, 0, state.levels.length-1);
    if (!keepStats) { state.score = 0; state.lives = 3; }
    buildBricksFromGrid();
    resetPaddleAndBalls();
    ui.levelNum.textContent = String(state.levelIndex+1);
    ui.levelName.textContent = (state.levels[state.levelIndex]?.name || '');
    setHUD();
  }

  function nextLevel() {
    audio.win();
    if (state.levelIndex < state.levels.length-1) startLevel(state.levelIndex+1, true);
    else startLevel(0, true);
  }

  function setHUD() {
    ui.score.textContent = String(state.score);
    ui.lives.textContent = String(state.lives);
    ui.levelNum.textContent = String(state.levelIndex+1);
    ui.levelName.textContent = state.levels[state.levelIndex]?.name || '';
  }

  // ---------- RENDERING ---------------------------------------------------
  function clear() {
    ctx.fillStyle = '#0a1018';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function roundRect(ctx, x, y, w, h, r=6, fill=true) {
    const rr = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr, y);
    ctx.arcTo(x+w, y, x+w, y+h, rr);
    ctx.arcTo(x+w, y+h, x, y+h, rr);
    ctx.arcTo(x, y+h, x, y, rr);
    ctx.arcTo(x, y, x+w, y, rr);
    ctx.closePath();
    if (fill) ctx.fill();
  }

  function drawPaddle() {
    ctx.fillStyle = '#e5e7eb';
    roundRect(ctx, state.paddle.x, state.paddle.y, state.paddle.w, state.paddle.h, 8, true);
    // Laser indicator
    if (state.timers.laserEnd > nowSec()) {
      const left = state.paddle.x, right = state.paddle.x + state.paddle.w;
      ctx.fillStyle = 'rgba(255,80,120,0.12)';
      ctx.fillRect(left, state.paddle.y-8, state.paddle.w, 6);
    }
  }

  function drawBalls() {
    for (const b of state.balls) {
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
      ctx.fillStyle = '#22d3ee';
      ctx.fill();
      // glow
      ctx.shadowBlur = 10; ctx.shadowColor = 'rgba(34,211,238,0.25)';
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawBricks() {
    for (const b of state.bricks) {
      if (!b.alive) continue;
      // color by hp or kind
      let color = '#60a5fa';
      if (b.kind === 'X') color = '#6b7280'; // steel
      else if (/^[1-9]$/.test(String(b.hp))) {
        const map = ['#2dd4bf','#60a5fa','#fb7185','#fbbf24','#a78bfa','#34d399','#f472b6','#f59e0b','#ef4444'];
        color = map[clamp(b.hp-1,0,map.length-1)];
      } else {
        // special kinds mapping
        const mapKind = { M:'#f472b6', W:'#34d399', S:'#fb7185', L:'#fbbf24' };
        color = mapKind[b.kind] || '#60a5fa';
      }
      ctx.fillStyle = color;
      roundRect(ctx, b.x, b.y, b.w, b.h, 6, true);
      // subtle outline for steel
      if (b.kind === 'X') {
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.strokeRect(b.x+1,b.y+1,b.w-2,b.h-2);
      }
    }
  }

  function drawPowerups() {
    for (const p of state.powerups) {
      // draw a simple circle with letter
      ctx.beginPath();
      ctx.arc(p.x+p.w/2, p.y+p.h/2, Math.min(p.w,p.h)/2, 0, Math.PI*2);
      ctx.fillStyle = '#111827';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.floor(p.h*0.55)}px ui-sans-serif, system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.type, p.x+p.w/2, p.y+p.h/2 + 1);
    }
  }

  function drawBullets() {
    ctx.fillStyle = '#ff7ab6';
    for (const b of state.bullets) {
      ctx.fillRect(b.x-3, b.y-8, 6, 12);
    }
  }

  function render() {
    clear();
    drawBricks();
    drawPaddle();
    drawBalls();
    drawPowerups();
    drawBullets();

    if (!state.running) {
      ctx.fillStyle = 'rgba(0,0,0,0.44)';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.fillStyle = '#e5e7eb';
      ctx.font = 'bold 28px ui-sans-serif, system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Tap / Space to Start', canvas.width/2, canvas.height/2 - 12);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '16px ui-sans-serif, system-ui';
      ctx.fillText('Drag or use ⬅️ ➡️ to move · ● to launch · Tap paddle to fire laser (when active)', canvas.width/2, canvas.height/2 + 18);
    }
  }

  // ---------- PHYSICS & COLLISIONS ---------------------------------------
  function circleIntersectsRect(c, r) {
    const cx = clamp(c.x, r.x, r.x + r.w);
    const cy = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - cx, dy = c.y - cy;
    return (dx*dx + dy*dy) <= (c.r * c.r);
  }

  function collisionNormal(c, r) {
    const cx = clamp(c.x, r.x, r.x + r.w);
    const cy = clamp(c.y, r.y, r.y + r.h);
    const dx = c.x - cx, dy = c.y - cy;
    const dist = Math.sqrt(dx*dx + dy*dy) || 0.0001;
    const pen = c.r - dist;
    let nx = dx / dist, ny = dy / dist;
    // if inside rect, push out in smallest overlap direction
    if (c.x > r.x && c.x < r.x + r.w && c.y > r.y && c.y < r.y + r.h) {
      const left = Math.abs(c.x - r.x), right = Math.abs(r.x + r.w - c.x);
      const top = Math.abs(c.y - r.y), bottom = Math.abs(r.y + r.h - c.y);
      const min = Math.min(left,right,top,bottom);
      if (min === left) { nx=-1; ny=0; }
      else if (min === right) { nx=1; ny=0; }
      else if (min === top) { nx=0; ny=-1; }
      else { nx=0; ny=1; }
      return { nx, ny, pen: c.r };
    }
    if (Math.abs(nx) > Math.abs(ny)) { ny = 0; nx = Math.sign(nx); }
    else { nx = 0; ny = Math.sign(ny); }
    return { nx, ny, pen: Math.max(0, pen) };
  }

  // ---------- POWERUP SPAWN / APPLY ---------------------------------------
  // When a brick dies, sometimes spawn a powerup. Some bricks encode powerups directly by kind letter.
  function maybeSpawnPowerupFromBrick(b) {
    // if brick had special kind like 'M', spawn that deterministically
    const kind = b.kind;
    if (['M','W','S','L'].includes(kind)) {
      spawnPowerup(kind, b.x + b.w/2, b.y + b.h/2);
      return;
    }
    // else probabilistic generic drop
    if (Math.random() < CONFIG.POWERUP.chance) {
      // choose a random effect (M/W/S/L)
      const pool = ['M','W','S','L'];
      const pick = pool[Math.floor(Math.random()*pool.length)];
      spawnPowerup(pick, b.x + b.w/2, b.y + b.h/2);
    }
  }

  function spawnPowerup(type, cx, cy) {
    const size = 28;
    const w = size, h = size;
    state.powerups.push({ x: cx - w/2, y: cy - h/2, w, h, type, vy: CONFIG.POWERUP.fallSpeed });
  }

  function applyPowerup(type) {
    const t = type.toUpperCase();
    audio.power();
    if (t === 'M') {
      // spawn N clones
      multiBallSpawn(CONFIG.MULTIBALL.clones);
    } else if (t === 'W') {
      // widen paddle temporarily
      state.paddle.w *= 1.6;
      state.timers.widenEnd = nowSec() + CONFIG.POWERUP.duration;
    } else if (t === 'S') {
      // shrink paddle temporarily
      state.paddle.w *= 0.6;
      state.timers.shrinkEnd = nowSec() + CONFIG.POWERUP.duration;
    } else if (t === 'L') {
      // activate laser
      state.timers.laserEnd = nowSec() + CONFIG.LASER.life;
    }
    // clamp paddle inside bounds
    state.paddle.x = clamp(state.paddle.x, 0, canvas.width - state.paddle.w);
  }

  // ---------- MULTI-BALL --------------------------------------------------
  function multiBallSpawn(n) {
    // spawn n additional balls: clone velocity rotated slightly
    const existing = state.balls.slice(); // include stuck ball too
    const clones = [];
    for (let i=0;i<n;i++) {
      const base = existing[i % existing.length];
      const angle = rand(-0.6, 0.6);
      const speed = base.speed * (1 + rand(-0.06, 0.08));
      const vx = Math.sin(angle) * speed * (Math.sign(base.vx) || (Math.random()<0.5?-1:1));
      const vy = -Math.abs(Math.cos(angle) * speed);
      clones.push({
        x: base.x + rand(-12,12),
        y: base.y + rand(-6,6),
        vx, vy, r: base.r, speed, stuck: false
      });
    }
    // release stuck ball if present
    for (const b of state.balls) if (b.stuck) b.stuck = false;
    state.balls.push(...clones);
  }

  // ---------- LASER BULLETS -----------------------------------------------
  let lastLaserShot = 0;
  function tryShootLaser() {
    if (nowSec() > state.timers.laserEnd) return;
    const tnow = nowSec();
    if (tnow - lastLaserShot < CONFIG.LASER.cooldown) return;
    lastLaserShot = tnow;
    // two bullets from paddle edges or center
    const cx = state.paddle.x + state.paddle.w/2;
    const left = state.paddle.x + 12;
    const right = state.paddle.x + state.paddle.w - 12;
    state.bullets.push({ x:left, y:state.paddle.y - 6, vx:0, vy:-CONFIG.LASER.bulletSpeed, born:tnow });
    state.bullets.push({ x:right, y:state.paddle.y - 6, vx:0, vy:-CONFIG.LASER.bulletSpeed, born:tnow });
  }

  // ---------- GAME UPDATE (physics & logic) -------------------------------
  function update(dt) {
    const mul = state.speedMul;

    // check portrait mode timers and revert paddle sizes
    const now = nowSec();
    if (state.timers.widenEnd && now > state.timers.widenEnd) {
      // revert to normal width (approx)
      state.paddle.w = CONFIG.PADDLE.w * (state.portraitMode ? CONFIG.MOBILE.portraitPaddleScale : 1);
      state.timers.widenEnd = 0;
    }
    if (state.timers.shrinkEnd && now > state.timers.shrinkEnd) {
      state.paddle.w = CONFIG.PADDLE.w * (state.portraitMode ? CONFIG.MOBILE.portraitPaddleScale : 1);
      state.timers.shrinkEnd = 0;
    }
    if (state.timers.laserEnd && now > state.timers.laserEnd) {
      state.timers.laserEnd = 0;
    }

    // paddle movement via keys
    let pxv = 0;
    if (keys.has('ArrowLeft')) pxv -= 1;
    if (keys.has('ArrowRight')) pxv += 1;
    state.paddle.vx = pxv * CONFIG.PADDLE.speed * mul;
    state.paddle.x = clamp(state.paddle.x + state.paddle.vx * dt, 0, canvas.width - state.paddle.w);

    // shoot laser on paddle click / space? We'll also allow tapping paddle to shoot (handled separately)
    if (keys.has('KeyF')) { tryShootLaser(); keys.delete('KeyF'); } // debug

    // launch with Space if stuck
    if (keys.has('Space')) { // toggle start if stopped
      if (!state.running) { state.running = true; audio.start(); }
      // launch stuck balls
      for (const b of state.balls) if (b.stuck) b.stuck = false;
      keys.delete('Space');
    }

    // update powerups (falling)
    for (const p of state.powerups) {
      p.y += p.vy * dt * mul;
    }
    // remove off-screen powerups and handle collection
    for (let i = state.powerups.length - 1; i >= 0; i--) {
      const p = state.powerups[i];
      const rect = { x: state.paddle.x, y: state.paddle.y, w: state.paddle.w, h: state.paddle.h };
      if (p.y > canvas.height + 40) { state.powerups.splice(i,1); continue; }
      if (rectIntersectsRect({x:p.x,y:p.y,w:p.w,h:p.h}, rect)) {
        applyPowerup(p.type);
        state.powerups.splice(i,1);
      }
    }

    // update bullets
    for (const b of state.bullets) {
      b.y += b.vy * dt * mul;
    }
    // remove bullets off-screen
    state.bullets = state.bullets.filter(b => b.y > -20);

    // update balls
    for (const b of state.balls) {
      if (b.stuck) {
        // keep on paddle
        b.x = state.paddle.x + state.paddle.w/2 + (b.x - (state.paddle.x + state.paddle.w/2 || 0)); // keep relative
        b.y = state.paddle.y - b.r - 1;
        continue;
      }
      b.x += b.vx * dt * mul;
      b.y += b.vy * dt * mul;

      // wall collisions
      if (b.x - b.r < 0) { b.x = b.r; b.vx *= -1; audio.wall(); }
      else if (b.x + b.r > canvas.width) { b.x = canvas.width - b.r; b.vx *= -1; audio.wall(); }
      if (b.y - b.r < 0) { b.y = b.r; b.vy *= -1; audio.wall(); }

      // paddle collision
      const paddleRect = { x: state.paddle.x, y: state.paddle.y, w: state.paddle.w, h: state.paddle.h };
      if (circleIntersectsRect(b, paddleRect) && b.vy > 0) {
        b.y = state.paddle.y - b.r - 0.01;
        const rel = (b.x - (state.paddle.x + state.paddle.w/2)) / (state.paddle.w/2);
        const angle = rel * (Math.PI / 2.6);
        const speed = clamp(Math.hypot(b.vx, b.vy) * 1.03, CONFIG.BALL.speed, CONFIG.BALL.maxSpeed);
        b.vx = Math.sin(angle) * speed;
        b.vy = -Math.abs(Math.cos(angle) * speed);
        b.speed = speed;
        audio.paddle();
      }

      // brick collisions (first-match break)
      let hitBrick = null;
      for (const br of state.bricks) {
        if (!br.alive) continue;
        if (circleIntersectsRect(b, br)) {
          hitBrick = br;
          const overlap = collisionNormal(b, br);
          if (overlap.nx !== 0) b.vx *= -1;
          if (overlap.ny !== 0) b.vy *= -1;
          b.x += overlap.nx * overlap.pen;
          b.y += overlap.ny * overlap.pen;
          break;
        }
      }
      if (hitBrick) {
        // If steel/unbreakable, just ping; else decrement hp
        if (hitBrick.kind === 'X') {
          audio.wall();
        } else {
          hitBrick.hp -= 1;
          audio.brick();
          if (hitBrick.hp <= 0) {
            hitBrick.alive = false;
            // spawn powerup sometimes or from kind
            maybeSpawnPowerupFromBrick(hitBrick);
            state.score += 10;
            setHUD();
          }
        }
      }

      // ball falls below screen
      if (b.y - b.r > canvas.height + 20) {
        // remove this ball
        // find index
        // if this was the last ball, lose a life and respawn
        // else just remove ball
        // collecting index safely:
        b._dead = true;
      }
    }

    // purge dead balls
    for (let i=state.balls.length-1;i>=0;i--) {
      if (state.balls[i]._dead) state.balls.splice(i,1);
    }

    if (state.balls.length === 0) {
      // lost a life
      state.lives -= 1; setHUD(); audio.lose();
      if (state.lives <= 0) {
        // game over -> restart at same level but reset score/lives
        state.running = false;
        state.score = 0; state.lives = 3;
        startLevel(state.levelIndex, true);
        return;
      } else {
        // respawn paddle & single ball
        resetPaddleAndBalls();
        return;
      }
    }

    // bullets vs bricks
    for (let i = state.bullets.length-1; i>=0; i--) {
      const bullet = state.bullets[i];
      let hit = false;
      for (const br of state.bricks) {
        if (!br.alive) continue;
        if (rectIntersectsRect({x:bullet.x-3,y:bullet.y-8,w:6,h:12}, br)) {
          if (br.kind === 'X') {
            // steel: bullets do nothing (maybe ping)
            audio.wall();
          } else {
            br.hp -= 1;
            audio.brick();
            if (br.hp <= 0) {
              br.alive = false;
              maybeSpawnPowerupFromBrick(br);
              state.score += 10; setHUD();
            }
          }
          hit = true; break;
        }
      }
      if (hit) state.bullets.splice(i,1);
    }

    // check level clear
    if (state.bricks.every(b => !b.alive)) {
      nextLevel();
    }
  }

  // ---------- HELP: RECT INTERSECT ---------------------------------------
  function rectIntersectsRect(a,b) {
    return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
  }

  // ---------- LAUNCH / UI ACTIONS ----------------------------------------
  function launchAllStuckBalls() {
    for (const b of state.balls) if (b.stuck) b.stuck = false;
  }
  function tryLaunch() {
    if (!state.running) { state.running = true; audio.start(); }
    launchAllStuckBalls();
  }

  // allow tapping paddle to shoot laser if laser active
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const y = (e.clientY - rect.top) * (canvas.height / rect.height);
    // if click inside paddle area and laser active -> shoot
    if (y >= state.paddle.y - 20 && nowSec() < state.timers.laserEnd) tryShootLaser();
    else tryLaunch();
  });
  canvas.addEventListener('touchend', (e) => {
    if (e.changedTouches && e.changedTouches.length) {
      const t = e.changedTouches[0];
      const rect = canvas.getBoundingClientRect();
      const y = (t.clientY - rect.top) * (canvas.height / rect.height);
      if (y >= state.paddle.y - 20 && nowSec() < state.timers.laserEnd) tryShootLaser();
      else tryLaunch();
    } else tryLaunch();
  }, {passive:false});

  // ---------- GAME LOOP ---------------------------------------------------
  function loop(now) {
    const dt = Math.min((now - state.last)/1000, 0.033);
    state.last = now;
    if (state.running) {
      update(dt);
      render();
    } else {
      render();
    }
    requestAnimationFrame(loop);
  }

  // ---------- RESIZE & PORTRAIT MODE -------------------------------------
  function fitCanvas() {
    // keep the canvas internal resolution stable for physics
    canvas.width = CONFIG.BASE_WIDTH;
    canvas.height = CONFIG.BASE_HEIGHT;
    // scale to parent container but respect aspect ratio
    const parent = canvas.parentElement.getBoundingClientRect();
    let w = parent.width - 2;
    let h = w / CONFIG.ASPECT;
    if (h > parent.height - 2) { h = parent.height - 2; w = h * CONFIG.ASPECT; }
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    // determine portrait mode (phone tall)
    const portrait = window.innerHeight > window.innerWidth;
    state.portraitMode = portrait && window.innerWidth <= CONFIG.MOBILE.breakpoint;
    // adjust paddle/ball sizes to be mobile-friendly
    if (portrait && window.innerWidth <= CONFIG.MOBILE.breakpoint) {
      CONFIG.PADDLE.w = Math.round(120 * CONFIG.MOBILE.portraitPaddleScale);
      // reduce ball speed a bit for touch play
      // keep these modifications non-destructive by using portrait flags (we already use them at reset)
    } else {
      CONFIG.PADDLE.w = 120;
    }
    // rebuild bricks to fit new dimensions (preserve paddle x% and ball positions roughly)
    const px = (canvas.width>0) ? (state.paddle.x / (canvas.width || 1)) : 0.5;
    buildBricksFromGrid();
    state.paddle.x = clamp(px * canvas.width, 0, canvas.width - state.paddle.w);
    // if ball stuck, reposition
    for (const b of state.balls) {
      if (b.stuck) {
        b.x = state.paddle.x + state.paddle.w/2;
        b.y = state.paddle.y - b.r - 1;
      }
    }
  }
  window.addEventListener('resize', () => {
    fitCanvas();
  });

  // ---------- UI BINDINGS -------------------------------------------------
  ui.start.addEventListener('click', () => {
    state.running = !state.running;
    state.running ? audio.start() : audio.pause();
  });
  ui.reset.addEventListener('click', () => {
    state.running = false;
    state.score = 0; state.lives = 3;
    startLevel(state.levelIndex, true);
  });
  ui.speed.addEventListener('input', (e) => { state.speedMul = Number(e.target.value) || 1; });
  if (ui.levelSelect) {
    ui.levelSelect.addEventListener('change', (e) => {
      const idx = parseInt(e.target.value,10) || 0;
      state.running = false; state.score = 0; state.lives = 3;
      startLevel(idx, true);
    });
  }

  // ---------- BOOTSTRAP & INIT --------------------------------------------
  async function init() {
    canvas.width = CONFIG.BASE_WIDTH; canvas.height = CONFIG.BASE_HEIGHT;
    await loadLevels();
    populateLevelSelect();
    fitCanvas();
    startLevel(0, false);
    requestAnimationFrame((t)=>{ state.last = t; loop(t); });
  }
  init();

  // ---------- UTILITY: collisions for rect --------------------------------
  function rectIntersectsRect(a,b) {
    return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
  }

})();
