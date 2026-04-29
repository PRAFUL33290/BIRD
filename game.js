/**
 * Flappy Bird – JavaScript / HTML5 Canvas implementation
 *
 * Entry point: the script runs as soon as it is loaded.
 * All game objects (Bird, PipeManager, SoundManager, etc.) are defined
 * as classes and wired together in the main GameEngine class at the bottom.
 *
 * Sections
 * --------
 * 1. Constants & helpers
 * 2. SoundManager  – procedural audio via Web Audio API
 * 3. Bird           – physics, animation, drawing
 * 4. Pipe           – a single pipe pair
 * 5. PipeManager    – spawning, recycling, collision, scoring
 * 6. ParticleSystem – feather burst on death
 * 7. Background     – scrolling sky, clouds, ground
 * 8. GameEngine     – state machine, game loop, input
 */

'use strict';

/* ================================================================
   1. CONSTANTS & HELPERS
   ================================================================ */

/** Logical (design) canvas dimensions – the game is always authored at
 *  this resolution and then scaled uniformly to fit any screen. */
const DESIGN_W = 360;
const DESIGN_H = 640;

/** Physics tick rate. Using a fixed dt makes physics deterministic
 *  regardless of actual frame-rate. */
const FIXED_DT = 1 / 60; // seconds

/** Gravity acceleration in logical pixels per second² */
const GRAVITY = 2200;

/** Upward velocity applied each time the player taps */
const FLAP_FORCE = -680;

/** Terminal falling velocity (caps downward speed) */
const MAX_FALL_SPEED = 750;

/** Horizontal speed of pipes at game start (px/s) */
const BASE_PIPE_SPEED = 160;

/** How much the pipe speed increases per point scored */
const SPEED_INCREMENT = 3;

/** Gap between the top and bottom pipe (logical pixels) */
const BASE_PIPE_GAP = 155;

/** How much the gap shrinks as the game progresses (min 110) */
const GAP_SHRINK = 1.5;
const MIN_PIPE_GAP = 110;

/** Horizontal distance between consecutive pipe pairs */
const PIPE_INTERVAL_X = 230;

/** Width of each pipe */
const PIPE_W = 52;

/** Height of the scrolling ground strip */
const GROUND_H = 80;

/** How many cloud objects are kept alive in the pool */
const CLOUD_COUNT = 5;

/**
 * Linear interpolation utility.
 * @param {number} a  Start value
 * @param {number} b  End value
 * @param {number} t  Progress [0..1]
 */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Clamp a number between min and max (inclusive).
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Return a random float in [lo, hi).
 */
function randBetween(lo, hi) {
  return lo + Math.random() * (hi - lo);
}

/* ================================================================
   2. SOUND MANAGER
   Uses the Web Audio API to synthesise short sound effects procedurally
   (no external audio files needed).
   ================================================================ */

class SoundManager {
  constructor() {
    /** AudioContext is created lazily on the first user gesture to satisfy
     *  browser autoplay policies. */
    this._ctx = null;
    this._masterGain = null;
    this._muted = false;
  }

  /** Lazily initialise the AudioContext (must be called from a user gesture). */
  _init() {
    if (this._ctx) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AudioContext();
      this._masterGain = this._ctx.createGain();
      this._masterGain.gain.value = 0.5;
      this._masterGain.connect(this._ctx.destination);
    } catch (_) {
      /* Audio not supported – silently degrade */
    }
  }

  /** Resume context if suspended (mobile browsers suspend until gesture). */
  _resume() {
    if (this._ctx && this._ctx.state === 'suspended') {
      this._ctx.resume();
    }
  }

  /**
   * Low-level helper: create an oscillator burst connected to the master gain.
   * @param {string}  type       OscillatorType ('sine' | 'square' | 'sawtooth')
   * @param {number}  freq       Starting frequency (Hz)
   * @param {number}  freqEnd    Ending frequency (Hz) – for pitch sweep
   * @param {number}  duration   Duration in seconds
   * @param {number}  vol        Volume [0..1] relative to master
   */
  _play(type, freq, freqEnd, duration, vol = 0.5) {
    if (this._muted || !this._ctx) return;
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, now + duration);

    gain.gain.setValueAtTime(vol, now);
    // Quick fade-out to avoid clicking artefacts
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

    osc.connect(gain);
    gain.connect(this._masterGain);

    osc.start(now);
    osc.stop(now + duration);
  }

  /** Short "fwip" flap sound */
  playFlap() {
    this._init();
    this._resume();
    this._play('sine', 380, 260, 0.12, 0.4);
  }

  /** Short ascending ding when the player passes a pipe */
  playScore() {
    this._init();
    this._resume();
    this._play('sine', 660, 880, 0.15, 0.6);
    // Harmonise with a slightly delayed second tone
    setTimeout(() => {
      if (this._ctx) this._play('sine', 880, 1100, 0.15, 0.4);
    }, 80);
  }

  /** Harsh descending buzz on collision */
  playHit() {
    this._init();
    this._resume();
    this._play('sawtooth', 250, 80, 0.3, 0.7);
  }

  /** Toggle mute state */
  toggleMute() {
    this._muted = !this._muted;
    return this._muted;
  }
}

/* ================================================================
   3. BIRD
   ================================================================ */

class Bird {
  /**
   * @param {number} x  Logical x position (stays mostly constant)
   * @param {number} y  Logical y start position
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vy = 0;          // vertical velocity (px/s)
    this.angle = 0;       // rotation in radians (nose-up / nose-down)
    this.radius = 16;     // collision circle radius

    /* Wing animation */
    this._wingPhase = 0;          // oscillator [0..2π]
    this._wingSpeed = 8;          // radians per second
    this._wingAmplitude = 0.4;    // how far wings flap (radians)
    this._isFlapping = false;     // true for a brief period after each tap

    /* Death state */
    this.dead = false;
    this._deathTimer = 0;

    /* Colours */
    this._bodyColor  = '#FFD700'; // golden yellow body
    this._wingColor  = '#FFA500'; // orange wings
    this._eyeColor   = '#FFFFFF';
    this._pupilColor = '#222222';
    this._beakColor  = '#FF6B35';
  }

  /** Apply a flap impulse. */
  flap() {
    this.vy = FLAP_FORCE;
    this._isFlapping = true;
    this._wingPhase = 0; // snap wing animation to downstroke start
  }

  /**
   * Advance physics by one fixed time-step.
   * @param {number} dt  Delta time in seconds (should equal FIXED_DT)
   */
  update(dt) {
    if (this.dead) {
      this._deathTimer += dt;
      return;
    }

    // Apply gravity
    this.vy += GRAVITY * dt;
    this.vy = Math.min(this.vy, MAX_FALL_SPEED);

    this.y += this.vy * dt;

    // Tilt the bird based on velocity:
    //   nose-up (negative angle) when going up, nose-down when falling
    const targetAngle = clamp(this.vy * 0.0018, -0.45, 1.2);
    this.angle = lerp(this.angle, targetAngle, 0.25);

    // Advance wing animation
    this._wingPhase += this._wingSpeed * dt;
    if (this._wingPhase > Math.PI * 2) {
      this._wingPhase -= Math.PI * 2;
      this._isFlapping = false;
    }
  }

  /**
   * Draw the bird onto the canvas context (already translated to bird centre).
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    const r = this.radius;

    // -- Lower wing (drawn behind body) --
    const wingOffset = Math.sin(this._wingPhase) * this._wingAmplitude * r;
    ctx.save();
    ctx.rotate(-0.3 + wingOffset * 0.8);
    ctx.fillStyle = this._wingColor;
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, r * 0.25, r * 0.7, r * 0.3, 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // -- Body --
    ctx.fillStyle = this._bodyColor;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * 0.85, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body sheen highlight
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.2, -r * 0.25, r * 0.45, r * 0.3, -0.3, 0, Math.PI * 2);
    ctx.fill();

    // -- Upper wing --
    ctx.save();
    ctx.rotate(-0.3 - wingOffset);
    ctx.fillStyle = this._wingColor;
    ctx.beginPath();
    ctx.ellipse(-r * 0.1, -r * 0.15, r * 0.75, r * 0.28, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // -- Eye white --
    ctx.fillStyle = this._eyeColor;
    ctx.beginPath();
    ctx.arc(r * 0.4, -r * 0.1, r * 0.32, 0, Math.PI * 2);
    ctx.fill();

    // -- Pupil --
    ctx.fillStyle = this._pupilColor;
    ctx.beginPath();
    ctx.arc(r * 0.48, -r * 0.08, r * 0.16, 0, Math.PI * 2);
    ctx.fill();

    // Catchlight
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(r * 0.54, -r * 0.14, r * 0.06, 0, Math.PI * 2);
    ctx.fill();

    // -- Beak --
    ctx.fillStyle = this._beakColor;
    ctx.beginPath();
    ctx.moveTo(r * 0.65, -r * 0.05);
    ctx.lineTo(r * 1.15, r * 0.08);
    ctx.lineTo(r * 0.65, r * 0.22);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }
}

/* ================================================================
   4. PIPE
   A single pipe pair (top + bottom column with a gap in the middle).
   ================================================================ */

class Pipe {
  /**
   * @param {number} x          Initial x position (right edge of canvas)
   * @param {number} gapCenter  Y coordinate of the gap's centre
   * @param {number} gapSize    Pixel height of the gap
   */
  constructor(x, gapCenter, gapSize) {
    this.x = x;
    this.gapCenter = gapCenter;
    this.gapSize = gapSize;
    this.width = PIPE_W;
    this.scored = false; // becomes true once the bird passes this pair
    this.active = true;  // false = off-screen, ready to be recycled
  }

  /** Move the pipe leftward at the given speed. */
  update(dt, speed) {
    this.x -= speed * dt;
    if (this.x + this.width < 0) {
      this.active = false;
    }
  }

  /**
   * Draw both pipes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} canvasH  Logical canvas height
   */
  draw(ctx, canvasH) {
    const halfGap = this.gapSize / 2;
    const topH    = this.gapCenter - halfGap;          // height of top pipe
    const botY    = this.gapCenter + halfGap;           // y-start of bottom pipe
    const botH    = canvasH - GROUND_H - botY;          // height of bottom pipe

    this._drawPipe(ctx, this.x, 0, this.width, topH, true);
    this._drawPipe(ctx, this.x, botY, this.width, botH, false);
  }

  /**
   * Axis-aligned bounding box check for one pipe segment.
   * Returns true if the bird's circle overlaps.
   * @param {Bird} bird
   */
  collides(bird) {
    const halfGap = this.gapSize / 2;
    const topH    = this.gapCenter - halfGap;
    const botY    = this.gapCenter + halfGap;

    // Broad-phase: only check x overlap
    const bLeft  = bird.x - bird.radius;
    const bRight = bird.x + bird.radius;
    const pLeft  = this.x;
    const pRight = this.x + this.width;

    if (bRight < pLeft || bLeft > pRight) return false;

    // Narrow-phase: check y against top pipe and bottom pipe
    const bTop    = bird.y - bird.radius;
    const bBottom = bird.y + bird.radius;

    if (bTop < topH)   return true;  // hit top pipe
    if (bBottom > botY) return true; // hit bottom pipe

    return false;
  }

  /* ------ private drawing helpers ------ */

  /**
   * Draw a single pipe segment with a cap.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number}  x
   * @param {number}  y       Top-left y of the pipe body
   * @param {number}  w       Pipe width
   * @param {number}  h       Pipe height
   * @param {boolean} capBottom  If true, the decorative cap is at the bottom edge
   */
  _drawPipe(ctx, x, y, w, h, capBottom) {
    const capH = 18;   // height of the cap ledge
    const capW = w + 10; // cap is slightly wider than the body
    const capX = x - 5;

    // Pipe body gradient (green hues)
    const bodyGrad = ctx.createLinearGradient(x, 0, x + w, 0);
    bodyGrad.addColorStop(0,    '#2ecc71');
    bodyGrad.addColorStop(0.35, '#27ae60');
    bodyGrad.addColorStop(0.65, '#1e8449');
    bodyGrad.addColorStop(1,    '#145a32');

    ctx.fillStyle = bodyGrad;
    ctx.fillRect(x, y, w, h);

    // Dark outline on pipe body
    ctx.strokeStyle = '#0d3b23';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);

    // Cap position
    const capY = capBottom ? y + h - capH : y;

    // Cap gradient
    const capGrad = ctx.createLinearGradient(capX, 0, capX + capW, 0);
    capGrad.addColorStop(0,    '#58d68d');
    capGrad.addColorStop(0.35, '#27ae60');
    capGrad.addColorStop(0.65, '#1e8449');
    capGrad.addColorStop(1,    '#0e6030');

    ctx.fillStyle = capGrad;
    ctx.beginPath();
    ctx.roundRect(capX, capY, capW, capH, 4);
    ctx.fill();

    ctx.strokeStyle = '#0d3b23';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Shine strip
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x + 4, y, 8, h);
  }
}

/* ================================================================
   5. PIPE MANAGER
   Handles spawning new pipes, recycling off-screen ones, collision
   testing, and score tracking.
   ================================================================ */

class PipeManager {
  constructor() {
    /** @type {Pipe[]} */
    this.pipes = [];
    this._spawnX = DESIGN_W + PIPE_W; // x where the next pipe will appear
    this._nextSpawnX = DESIGN_W;       // x-scroll distance until next spawn
    this._score = 0;
    this._speed = BASE_PIPE_SPEED;
  }

  /** Reset to initial state (called on new game). */
  reset() {
    this.pipes = [];
    this._nextSpawnX = DESIGN_W;
    this._score = 0;
    this._speed = BASE_PIPE_SPEED;
  }

  /** Current score. */
  get score() { return this._score; }

  /** Current pipe speed. */
  get speed() { return this._speed; }

  /**
   * Advance all pipes and spawn new ones as needed.
   * @param {number} dt       Fixed delta time (s)
   * @param {number} canvasH  Logical canvas height
   */
  update(dt, canvasH) {
    // Move existing pipes
    for (const pipe of this.pipes) {
      pipe.update(dt, this._speed);
    }

    // Remove off-screen pipes
    this.pipes = this.pipes.filter(p => p.active);

    // Check if it's time to spawn a new pipe
    // We track by measuring how far the "last spawned" virtual x has moved
    this._nextSpawnX -= this._speed * dt;
    if (this._nextSpawnX <= 0) {
      this._spawnPipe(canvasH);
      this._nextSpawnX += PIPE_INTERVAL_X;
    }
  }

  /**
   * Test collision of a Bird against all active pipes.
   * @param {Bird} bird
   * @returns {boolean}
   */
  testCollision(bird) {
    for (const pipe of this.pipes) {
      if (pipe.collides(bird)) return true;
    }
    return false;
  }

  /**
   * Check whether the bird has passed any un-scored pipes and increment score.
   * @param {Bird}     bird
   * @param {Function} onScore  Callback with no args
   */
  checkScore(bird, onScore) {
    for (const pipe of this.pipes) {
      if (!pipe.scored && pipe.x + pipe.width < bird.x - bird.radius) {
        pipe.scored = true;
        this._score += 1;
        // Increase speed and shrink gap progressively
        this._speed = BASE_PIPE_SPEED + this._score * SPEED_INCREMENT;
        onScore();
      }
    }
  }

  /**
   * Draw all active pipes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} canvasH
   */
  draw(ctx, canvasH) {
    for (const pipe of this.pipes) {
      pipe.draw(ctx, canvasH);
    }
  }

  /* ------ private ------ */

  _spawnPipe(canvasH) {
    const usableH = canvasH - GROUND_H;
    const gap     = Math.max(MIN_PIPE_GAP, BASE_PIPE_GAP - this._score * GAP_SHRINK);
    const minCenter = gap / 2 + 40;
    const maxCenter = usableH - gap / 2 - 40;
    const gapCenter = randBetween(minCenter, maxCenter);

    this.pipes.push(new Pipe(DESIGN_W + PIPE_W, gapCenter, gap));
  }
}

/* ================================================================
   6. PARTICLE SYSTEM
   Simple feather-burst effect when the bird hits an obstacle.
   ================================================================ */

class Particle {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = randBetween(-220, 220);
    this.vy = randBetween(-300, -60);
    this.life = 1.0;
    this.decay = randBetween(1.2, 2.5);
    this.size = randBetween(4, 10);
    this.color = ['#FFD700', '#FFA500', '#FF6B35', '#FFFFFF'][Math.floor(Math.random() * 4)];
    this.rotation = randBetween(0, Math.PI * 2);
    this.rotSpeed = randBetween(-5, 5);
  }

  update(dt) {
    this.x  += this.vx * dt;
    this.y  += this.vy * dt;
    this.vy += GRAVITY * 0.5 * dt; // particles fall too but slower
    this.life -= this.decay * dt;
    this.rotation += this.rotSpeed * dt;
  }

  draw(ctx) {
    if (this.life <= 0) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0, this.life);
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rotation);
    ctx.fillStyle = this.color;
    ctx.fillRect(-this.size / 2, -this.size / 2, this.size, this.size * 0.4);
    ctx.restore();
  }
}

class ParticleSystem {
  constructor() {
    /** @type {Particle[]} */
    this.particles = [];
  }

  /** Spawn a burst of feather particles at (x, y). */
  burst(x, y, count = 18) {
    for (let i = 0; i < count; i++) {
      this.particles.push(new Particle(x, y));
    }
  }

  update(dt) {
    for (const p of this.particles) p.update(dt);
    this.particles = this.particles.filter(p => p.life > 0);
  }

  draw(ctx) {
    for (const p of this.particles) p.draw(ctx);
  }
}

/* ================================================================
   7. BACKGROUND
   Scrolling layered background: sky gradient, clouds, ground strip.
   ================================================================ */

class Cloud {
  constructor(canvasW, canvasH, randomX = true) {
    this._reset(canvasW, canvasH, randomX);
  }

  _reset(canvasW, canvasH, randomX = false) {
    this.x = randomX
      ? randBetween(-canvasW, canvasW * 2)
      : canvasW + randBetween(20, 120);
    this.y      = randBetween(30, canvasH * 0.45);
    this.speed  = randBetween(20, 50);
    this.scaleX = randBetween(0.7, 1.4);
    this.scaleY = randBetween(0.5, 1.0);
    this.alpha  = randBetween(0.6, 0.9);
  }

  update(dt, canvasW, canvasH) {
    this.x -= this.speed * dt;
    if (this.x < -150) this._reset(canvasW, canvasH);
  }

  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.alpha;
    ctx.fillStyle = '#ffffff';
    ctx.translate(this.x, this.y);
    ctx.scale(this.scaleX, this.scaleY);
    // Simple cloud: three overlapping circles
    ctx.beginPath();
    ctx.arc(0,    0,  28, 0, Math.PI * 2);
    ctx.arc(35,  -8,  22, 0, Math.PI * 2);
    ctx.arc(-30, -5,  20, 0, Math.PI * 2);
    ctx.arc(18,   8,  18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

class Background {
  constructor(canvasW, canvasH) {
    this._canvasW = canvasW;
    this._canvasH = canvasH;

    /** Gradient stops for the sky (top → bottom) */
    this._skyColors = ['#87CEEB', '#B0E2FF', '#E0F4FF'];

    /** Clouds pool */
    this._clouds = Array.from(
      { length: CLOUD_COUNT },
      () => new Cloud(canvasW, canvasH, true)
    );

    /** Scrolling ground offset for animated texture */
    this._groundOffset = 0;
  }

  update(dt, pipeSpeed) {
    // Clouds scroll at a fraction of the pipe speed for a parallax feel,
    // plus their own individual drift speed for variety.
    for (const c of this._clouds) {
      c.x -= pipeSpeed * 0.25 * dt;
      c.update(dt, this._canvasW, this._canvasH);
    }
    // Scroll the ground texture with the pipe speed
    this._groundOffset = (this._groundOffset + pipeSpeed * dt) % 40;
  }

  /**
   * Draw the background layers.
   * @param {CanvasRenderingContext2D} ctx
   */
  draw(ctx) {
    const w = this._canvasW;
    const h = this._canvasH;

    // Sky gradient
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h - GROUND_H);
    skyGrad.addColorStop(0,   '#4facfe');
    skyGrad.addColorStop(0.5, '#87CEEB');
    skyGrad.addColorStop(1,   '#c8eeff');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h - GROUND_H);

    // Clouds
    for (const c of this._clouds) c.draw(ctx);

    // Ground strip
    this._drawGround(ctx, w, h);
  }

  _drawGround(ctx, w, h) {
    const y = h - GROUND_H;

    // Base earth colour
    const groundGrad = ctx.createLinearGradient(0, y, 0, h);
    groundGrad.addColorStop(0,   '#8B6914');
    groundGrad.addColorStop(0.2, '#A0522D');
    groundGrad.addColorStop(1,   '#6B3A2A');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, y, w, GROUND_H);

    // Grass strip at the top of the ground
    ctx.fillStyle = '#5D8A3C';
    ctx.fillRect(0, y, w, 16);

    // Lighter grass highlight
    ctx.fillStyle = '#7AB648';
    ctx.fillRect(0, y, w, 7);

    // Animated dirt texture: repeating vertical lines
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    const stripeSpacing = 40;
    const startX = -(this._groundOffset % stripeSpacing);
    for (let x = startX; x < w + stripeSpacing; x += stripeSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, y + 16);
      ctx.lineTo(x - 12, h);
      ctx.stroke();
    }
  }
}

/* ================================================================
   8. GAME ENGINE
   Top-level state machine and requestAnimationFrame loop.
   ================================================================ */

/** Possible game states */
const STATE = {
  START:    'start',
  PLAYING:  'playing',
  DYING:    'dying',    // brief invincibility period / death anim
  GAMEOVER: 'gameover',
};

class GameEngine {
  constructor() {
    /* ---------- Canvas setup ---------- */
    this._canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gameCanvas'));
    this._ctx    = this._canvas.getContext('2d');

    // Scale the canvas to fit the device while preserving the design ratio
    this._scale = 1;
    this._resize();
    window.addEventListener('resize', () => this._resize());

    /* ---------- Subsystems ---------- */
    this._sound     = new SoundManager();
    this._bg        = new Background(DESIGN_W, DESIGN_H);
    this._bird      = new Bird(DESIGN_W * 0.28, DESIGN_H / 2);
    this._pipes     = new PipeManager();
    this._particles = new ParticleSystem();

    /* ---------- Game state ---------- */
    this._state     = STATE.START;
    this._bestScore = this._loadBestScore();
    this._dyingTimer = 0;
    this._flashAlpha = 0; // white flash on collision

    /* ---------- Idle animation for start / game-over screen ---------- */
    this._idleTime  = 0;   // used to bob the bird on menu screens

    /* ---------- Input ---------- */
    this._bindInput();

    /* ---------- Start loop ---------- */
    this._lastTime = null;
    this._accumulator = 0;
    requestAnimationFrame(ts => this._loop(ts));
  }

  /* ------------------------------------------------------------------
     Resize & scaling
     ------------------------------------------------------------------ */

  _resize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    this._scale = scale;

    this._canvas.width  = DESIGN_W;
    this._canvas.height = DESIGN_H;
    this._canvas.style.width  = `${DESIGN_W * scale}px`;
    this._canvas.style.height = `${DESIGN_H * scale}px`;
  }

  /* ------------------------------------------------------------------
     Input binding (keyboard + mouse + touch)
     ------------------------------------------------------------------ */

  _bindInput() {
    const handleAction = () => this._handleTap();

    // Keyboard: Space or Arrow-Up
    window.addEventListener('keydown', e => {
      if (e.code === 'Space' || e.code === 'ArrowUp') {
        e.preventDefault();
        handleAction();
      }
    });

    // Mouse click
    this._canvas.addEventListener('mousedown', e => {
      e.preventDefault();
      handleAction();
    });

    // Touch tap – use touchstart for fastest response
    this._canvas.addEventListener('touchstart', e => {
      e.preventDefault();
      handleAction();
    }, { passive: false });
  }

  /** Unified tap/click/key handler. */
  _handleTap() {
    switch (this._state) {
      case STATE.START:
        this._startGame();
        break;
      case STATE.PLAYING:
        this._bird.flap();
        this._sound.playFlap();
        break;
      case STATE.GAMEOVER:
        this._startGame();
        break;
      // During DYING we ignore taps
    }
  }

  /* ------------------------------------------------------------------
     Game lifecycle
     ------------------------------------------------------------------ */

  _startGame() {
    this._bird      = new Bird(DESIGN_W * 0.28, DESIGN_H / 2);
    this._pipes     = new PipeManager();
    this._particles = new ParticleSystem();
    this._flashAlpha = 0;
    this._idleTime   = 0;
    this._dyingTimer = 0;
    this._state      = STATE.PLAYING;
  }

  _killBird() {
    if (this._state !== STATE.PLAYING) return;
    this._state = STATE.DYING;
    this._dyingTimer = 0;
    this._bird.dead = true;
    this._bird.vy = FLAP_FORCE * 0.5; // slight upward bounce before falling
    this._sound.playHit();
    this._flashAlpha = 1.0; // trigger white flash
    this._particles.burst(this._bird.x, this._bird.y);

    // Save best score
    const score = this._pipes.score;
    if (score > this._bestScore) {
      this._bestScore = score;
      this._saveBestScore(score);
    }
  }

  /* ------------------------------------------------------------------
     Main game loop
     ------------------------------------------------------------------ */

  _loop(timestamp) {
    if (this._lastTime === null) this._lastTime = timestamp;
    const rawDt = (timestamp - this._lastTime) / 1000; // seconds
    this._lastTime = timestamp;

    // Cap dt to avoid huge jumps after tab switching
    const dt = Math.min(rawDt, 0.05);

    this._accumulator += dt;

    // Fixed-step physics
    while (this._accumulator >= FIXED_DT) {
      this._update(FIXED_DT);
      this._accumulator -= FIXED_DT;
    }

    this._draw();

    requestAnimationFrame(ts => this._loop(ts));
  }

  /* ------------------------------------------------------------------
     Update
     ------------------------------------------------------------------ */

  _update(dt) {
    switch (this._state) {

      case STATE.START:
        this._idleTime += dt;
        // Gentle hover: bob bird up and down
        this._bird.y = DESIGN_H / 2 + Math.sin(this._idleTime * 2.5) * 14;
        this._bird.angle = Math.sin(this._idleTime * 2.5) * 0.15;
        this._bird._wingPhase += 6 * dt;
        this._bg.update(dt, BASE_PIPE_SPEED * 0.4);
        break;

      case STATE.PLAYING:
        this._bg.update(dt, this._pipes.speed);
        this._bird.update(dt);

        // Ground collision
        if (this._bird.y + this._bird.radius >= DESIGN_H - GROUND_H) {
          this._bird.y = DESIGN_H - GROUND_H - this._bird.radius;
          this._killBird();
          break;
        }

        // Ceiling collision (optional – feels fair)
        if (this._bird.y - this._bird.radius < 0) {
          this._bird.y = this._bird.radius;
          this._bird.vy = 0;
        }

        // Pipe updates (movement, spawn, recycle) + score detection
        this._pipes.update(dt, DESIGN_H);
        this._pipes.checkScore(this._bird, () => {
          this._sound.playScore();
        });

        // Pipe collision
        if (this._pipes.testCollision(this._bird)) {
          this._killBird();
        }

        this._particles.update(dt);
        break;

      case STATE.DYING:
        this._dyingTimer += dt;
        this._bg.update(dt, 0); // freeze background
        // Bird continues to fall under gravity while dying
        this._bird.vy += GRAVITY * dt;
        this._bird.vy = Math.min(this._bird.vy, MAX_FALL_SPEED);
        this._bird.y += this._bird.vy * dt;
        // Spin bird
        this._bird.angle = lerp(this._bird.angle, Math.PI / 2, 0.12);
        this._particles.update(dt);
        // Fade white flash
        this._flashAlpha = Math.max(0, this._flashAlpha - 4 * dt);

        // Transition to game-over screen after brief pause
        if (this._dyingTimer > 1.2) {
          this._state = STATE.GAMEOVER;
        }
        break;

      case STATE.GAMEOVER:
        this._bg.update(dt, 0);
        this._particles.update(dt);
        // Keep flash fading
        this._flashAlpha = Math.max(0, this._flashAlpha - 4 * dt);
        break;
    }
  }

  /* ------------------------------------------------------------------
     Draw
     ------------------------------------------------------------------ */

  _draw() {
    const ctx = this._ctx;
    const w = DESIGN_W;
    const h = DESIGN_H;

    ctx.clearRect(0, 0, w, h);

    // Background (sky + clouds + ground)
    this._bg.draw(ctx);

    if (this._state !== STATE.START) {
      // Pipes
      this._pipes.draw(ctx, h);
      // Particles
      this._particles.draw(ctx);
    }

    // Bird
    this._bird.draw(ctx);

    // White flash overlay
    if (this._flashAlpha > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this._flashAlpha})`;
      ctx.fillRect(0, 0, w, h);
    }

    // HUD / overlays
    switch (this._state) {
      case STATE.START:
        this._drawStartScreen(ctx, w, h);
        break;
      case STATE.PLAYING:
        this._drawHUD(ctx, w);
        break;
      case STATE.DYING:
        this._drawHUD(ctx, w);
        break;
      case STATE.GAMEOVER:
        this._drawHUD(ctx, w);
        this._drawGameOverScreen(ctx, w, h);
        break;
    }
  }

  /* ------ HUD: live score display ------ */
  _drawHUD(ctx, w) {
    const score = this._pipes.score;
    ctx.save();

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.font = 'bold 42px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(score, w / 2 + 2, 62);

    // Score text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(score, w / 2, 60);

    ctx.restore();
  }

  /* ------ Start screen ------ */
  _drawStartScreen(ctx, w, h) {
    // Semi-transparent overlay
    ctx.fillStyle = 'rgba(0, 20, 60, 0.45)';
    ctx.fillRect(0, 0, w, h);

    // Title
    ctx.save();
    ctx.textAlign = 'center';

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.font = 'bold 52px Arial, sans-serif';
    ctx.fillText('FLAPPY BIRD', w / 2 + 3, h * 0.28 + 3);

    // Title with gradient
    const titleGrad = ctx.createLinearGradient(0, h * 0.2, 0, h * 0.32);
    titleGrad.addColorStop(0, '#FFD700');
    titleGrad.addColorStop(1, '#FFA500');
    ctx.fillStyle = titleGrad;
    ctx.font = 'bold 52px Arial, sans-serif';
    ctx.fillText('FLAPPY BIRD', w / 2, h * 0.28);

    // Subtitle
    ctx.fillStyle = '#ffffff';
    ctx.font = '18px Arial, sans-serif';
    ctx.fillText('Tap / Space / Click to start', w / 2, h * 0.38);

    // Animated "tap" hint with pulsing opacity
    const pulse = 0.55 + 0.45 * Math.sin(Date.now() / 400);
    ctx.fillStyle = `rgba(255,255,255,${pulse})`;
    ctx.font = 'bold 22px Arial, sans-serif';
    ctx.fillText('▼  TAP TO PLAY  ▼', w / 2, h * 0.80);

    // Best score
    if (this._bestScore > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '17px Arial, sans-serif';
      ctx.fillText(`Best: ${this._bestScore}`, w / 2, h * 0.88);
    }

    ctx.restore();
  }

  /* ------ Game over screen ------ */
  _drawGameOverScreen(ctx, w, h) {
    // Rounded card background
    const cardW = 270;
    const cardH = 200;
    const cardX = (w - cardW) / 2;
    const cardY = h * 0.3;

    ctx.save();

    // Card shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.roundRect(cardX + 4, cardY + 4, cardW, cardH, 16);
    ctx.fill();

    // Card body
    const cardGrad = ctx.createLinearGradient(cardX, cardY, cardX, cardY + cardH);
    cardGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
    cardGrad.addColorStop(1, 'rgba(220,235,255,0.95)');
    ctx.fillStyle = cardGrad;
    ctx.beginPath();
    ctx.roundRect(cardX, cardY, cardW, cardH, 16);
    ctx.fill();

    // "GAME OVER" header
    ctx.fillStyle = '#CC0000';
    ctx.font = 'bold 32px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', w / 2, cardY + 48);

    // Score
    ctx.fillStyle = '#333333';
    ctx.font = '20px Arial, sans-serif';
    ctx.fillText(`Score: ${this._pipes.score}`, w / 2, cardY + 86);

    // Best score
    const isNewBest = this._pipes.score >= this._bestScore && this._pipes.score > 0;
    if (isNewBest) {
      ctx.fillStyle = '#e67e22';
      ctx.font = 'bold 16px Arial, sans-serif';
      ctx.fillText('✨ NEW BEST! ✨', w / 2, cardY + 112);
    } else {
      ctx.fillStyle = '#555555';
      ctx.font = '16px Arial, sans-serif';
      ctx.fillText(`Best: ${this._bestScore}`, w / 2, cardY + 112);
    }

    // Restart button
    const btnW = 160;
    const btnH = 44;
    const btnX = (w - btnW) / 2;
    const btnY = cardY + cardH - 64;

    const btnGrad = ctx.createLinearGradient(btnX, btnY, btnX, btnY + btnH);
    btnGrad.addColorStop(0, '#27ae60');
    btnGrad.addColorStop(1, '#1a7a44');
    ctx.fillStyle = btnGrad;
    ctx.beginPath();
    ctx.roundRect(btnX, btnY, btnW, btnH, 22);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 20px Arial, sans-serif';
    ctx.fillText('▶  PLAY AGAIN', w / 2, btnY + 29);

    ctx.restore();
  }

  /* ------------------------------------------------------------------
     Persistent best score (localStorage)
     ------------------------------------------------------------------ */

  _loadBestScore() {
    try {
      return parseInt(localStorage.getItem('flappyBestScore') || '0', 10) || 0;
    } catch (_) {
      return 0;
    }
  }

  _saveBestScore(score) {
    try {
      localStorage.setItem('flappyBestScore', String(score));
    } catch (_) { /* private/incognito mode might block this */ }
  }
}

/* ================================================================
   BOOTSTRAP
   Wait for the DOM to be ready before creating the engine.
   ================================================================ */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new GameEngine());
} else {
  new GameEngine();
}
