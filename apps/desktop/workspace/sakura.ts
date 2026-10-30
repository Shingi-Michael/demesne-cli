/// Home's cherry blossom (pass 102 D, the anime print): two boughs drawn in
/// from the top corners over the start screen's top half, with cel-shaded
/// five-petal blossoms and buds. By night a large moon with a halo and a sky
/// of stars; by day a blue sky with cel clouds and faint beams of light. It is
/// a still picture, drawn when Home shows, when the window settles at a new
/// size and when the theme changes: nothing moves, so Home costs nothing while
/// it sits there. The boughs stop above the greeting, so no text sits on them.

export type Sakura = { pause(): void; resume(): void; setDark(dark: boolean): void; refit(): void };

type Palette = {
  sky: [string, string, string]; bark: string; rim: string; petal: [string, string]; tip: string;
  line: string; center: string; stamen: string; bud: string; glow: string;
};
const PALETTES: Record<"dark" | "light", Palette> = {
  dark: { sky: ["#141436", "#2c2150", "#3d2a55"], bark: "#2a1b2c", rim: "rgba(190,170,255,.55)", petal: ["#ffd9e6", "#f59bbb"], tip: "#fff2f6", line: "#a8406a", center: "#d6336c", stamen: "#ffe08a", bud: "#ee5f8e", glow: "rgba(255,170,205,.22)" },
  light: { sky: ["#7fc3ee", "#bfe0f6", "#fbe1ea"], bark: "#3a2530", rim: "rgba(255,240,230,.75)", petal: ["#ffe3ec", "#f7a5c0"], tip: "#ffffff", line: "#c2507a", center: "#e0457a", stamen: "#f2b84b", bud: "#f0628f", glow: "rgba(255,255,255,.55)" },
};
/// The bough Mike picked; the same one every launch.
const SEED = 3;

type Point = { x: number; y: number; w: number };
type Branch = Point[];
type Tip = { x: number; y: number; a: number; spur?: boolean };

function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// A bough grows as a limb that bends a little as it goes, side shoots along
/// it, a leader at its end, and short spurs where single blossoms sit.
function grow(r: () => number, from: [number, number], angle: number, length: number, width: number, depth: number, branches: Branch[], tips: Tip[]) {
  const pts: Point[] = [];
  let [x, y] = from, a = angle;
  const steps = Math.max(4, Math.round(length / 14)), bend = (r() - .5) * .5;
  for (let i = 0; i <= steps; i++) {
    pts.push({ x, y, w: width * (1 - i / steps * .55) });
    a += bend / steps + (r() - .5) * .16;
    x += Math.cos(a) * length / steps; y += Math.sin(a) * length / steps;
  }
  branches.push(pts);
  const end = pts[pts.length - 1]!;
  if (depth <= 0 || width < 1.1) { tips.push({ x: end.x, y: end.y, a }); return; }
  const shoots = depth > 2 ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2);
  for (let k = 0; k < shoots; k++) {
    const at = pts[Math.floor((.35 + r() * .55) * (pts.length - 1))]!;
    grow(r, [at.x, at.y], a + (r() < .5 ? -1 : 1) * (.45 + r() * .55), length * (.42 + r() * .25), at.w * (.5 + r() * .15), depth - 1, branches, tips);
  }
  grow(r, [end.x, end.y], a + (r() - .5) * .35, length * (.55 + r() * .2), end.w * .78, depth - 1, branches, tips);
  for (let k = 0; k < 3; k++) {
    const at = pts[Math.floor(r() * pts.length)]!;
    tips.push({ x: at.x, y: at.y, a: a + (r() - .5) * 2, spur: true });
  }
}

/// A limb: a smooth tapered shape in the bark ink, with a rim of light along
/// its upper edge.
function limb(ctx: CanvasRenderingContext2D, p: Branch, pal: Palette) {
  const left: [number, number][] = [], right: [number, number][] = [];
  p.forEach((q, i) => {
    const n = p[Math.min(i + 1, p.length - 1)]!, m = p[Math.max(i - 1, 0)]!;
    const dx = n.x - m.x, dy = n.y - m.y, l = Math.hypot(dx, dy) || 1;
    left.push([q.x - dy / l * q.w / 2, q.y + dx / l * q.w / 2]);
    right.push([q.x + dy / l * q.w / 2, q.y - dx / l * q.w / 2]);
  });
  const smooth = (pts: [number, number][], first: boolean) => {
    if (first) ctx.moveTo(pts[0]![0], pts[0]![1]); else ctx.lineTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i]![0], pts[i]![1], (pts[i]![0] + pts[i + 1]![0]) / 2, (pts[i]![1] + pts[i + 1]![1]) / 2);
    ctx.lineTo(pts[pts.length - 1]![0], pts[pts.length - 1]![1]);
  };
  ctx.beginPath(); smooth(left, true); smooth(right.slice().reverse(), false); ctx.closePath();
  ctx.fillStyle = pal.bark; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.beginPath(); smooth(left, true);
  ctx.strokeStyle = pal.rim; ctx.lineWidth = Math.max(1, p[0]!.w * .22); ctx.lineCap = "round"; ctx.stroke();
  ctx.restore();
}

/// One petal: rounded, with the cherry's notch at its tip.
function petal(ctx: CanvasRenderingContext2D, len: number, wid: number) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid * .9, -len * .15, wid * 1.05, -len * .78, wid * .32, -len * .98);
  ctx.quadraticCurveTo(wid * .1, -len * .86, 0, -len * .8);
  ctx.quadraticCurveTo(-wid * .1, -len * .86, -wid * .32, -len * .98);
  ctx.bezierCurveTo(-wid * 1.05, -len * .78, -wid * .9, -len * .15, 0, 0);
  ctx.closePath();
}

/// A blossom in flat cel tones: a deeper base, a pale upper half, a white
/// glint and a rose line, with its eye and stamens.
function blossom(ctx: CanvasRenderingContext2D, r: () => number, x: number, y: number, size: number, rot: number, tilt: number, pal: Palette, scale: number) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, tilt);
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI * 2 / 5 + (r() - .5) * .18);
    const len = size * (.92 + r() * .16), wid = size * .52;
    petal(ctx, len, wid);
    ctx.fillStyle = pal.petal[1]; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(0, -len * .72, wid * .95, len * .5, 0, 0, Math.PI * 2); ctx.fillStyle = pal.petal[0]; ctx.fill();
    ctx.beginPath(); ctx.ellipse(-wid * .28, -len * .78, wid * .16, len * .1, -.4, 0, Math.PI * 2); ctx.fillStyle = pal.tip; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = pal.line; ctx.lineWidth = .9 * scale; ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, size * .2, 0, Math.PI * 2); ctx.fillStyle = pal.center; ctx.globalAlpha = .9; ctx.fill(); ctx.globalAlpha = 1;
  const stamens = 9 + Math.floor(r() * 5);
  for (let i = 0; i < stamens; i++) {
    const a = r() * Math.PI * 2, l = size * (.35 + r() * .2);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
    ctx.strokeStyle = pal.center; ctx.globalAlpha = .55; ctx.lineWidth = .55 * scale; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(Math.cos(a) * l, Math.sin(a) * l, size * .045 + .4, 0, Math.PI * 2); ctx.fillStyle = pal.stamen; ctx.fill();
  }
  ctx.restore();
}

function bud(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, pal: Palette, scale: number) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -size * .9);
  ctx.strokeStyle = pal.bark; ctx.lineWidth = .8 * scale; ctx.stroke();
  ctx.beginPath(); ctx.ellipse(0, -size * 1.25, size * .32, size * .5, 0, 0, Math.PI * 2);
  ctx.fillStyle = pal.bud; ctx.fill();
  ctx.strokeStyle = pal.line; ctx.lineWidth = .8 * scale; ctx.stroke();
  ctx.restore();
}

/// The sky behind the boughs, over the top half.
function sky(ctx: CanvasRenderingContext2D, W: number, H: number, pal: Palette, dark: boolean, r: () => number, scale: number) {
  const top = H * .55, g = ctx.createLinearGradient(0, 0, 0, top);
  g.addColorStop(0, pal.sky[0]); g.addColorStop(.45, pal.sky[1]); g.addColorStop(.75, pal.sky[2]);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, top);
  if (dark) {
    // stars, a few with four points, and a big moon with its halo
    for (let i = 0; i < 90; i++) {
      const x = r() * W, y = r() * top * .8, s = (r() < .1 ? 1.6 : .7 + r() * .6) * scale;
      ctx.globalAlpha = .35 + r() * .55; ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill();
      if (s > 1.4 * scale) { ctx.fillRect(x - s * 4, y - .4 * scale, s * 8, .8 * scale); ctx.fillRect(x - .4 * scale, y - s * 4, .8 * scale, s * 8); }
    }
    ctx.globalAlpha = 1;
    const mx = W * .64, my = H * .13, mr = W * .07;
    const halo = ctx.createRadialGradient(mx, my, mr * .8, mx, my, mr * 3.2);
    halo.addColorStop(0, "rgba(255,226,236,.35)"); halo.addColorStop(1, "rgba(255,226,236,0)");
    ctx.fillStyle = halo; ctx.fillRect(mx - mr * 3.2, my - mr * 3.2, mr * 6.4, mr * 6.4);
    const disc = ctx.createRadialGradient(mx - mr * .3, my - mr * .3, mr * .1, mx, my, mr);
    disc.addColorStop(0, "#fffaf6"); disc.addColorStop(1, "#f7dbe4");
    ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fillStyle = disc; ctx.fill();
    return;
  }
  // cel clouds: a white body over a pale blue underside
  const cloud = (cx: number, cy: number, w: number) => {
    const puffs = [[0, 0, .32], [-.3, .08, .22], [.3, .07, .24], [-.12, -.12, .24], [.16, -.1, .2]] as const;
    ctx.fillStyle = "#dbe9f7";
    for (const [dx, dy, rr] of puffs) { ctx.beginPath(); ctx.arc(cx + dx * w, cy + dy * w + w * .05, rr * w, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#ffffff";
    for (const [dx, dy, rr] of puffs) { ctx.beginPath(); ctx.arc(cx + dx * w, cy + dy * w - w * .02, rr * w * .94, 0, Math.PI * 2); ctx.fill(); }
  };
  cloud(W * .58, H * .2, W * .2); cloud(W * .86, H * .3, W * .13); cloud(W * .3, H * .27, W * .1);
  // soft beams that fade before they reach the greeting
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const x = W * (.6 + i * .14), w = W * (.04 + i * .015);
    const beam = ctx.createLinearGradient(0, 0, 0, top * .8);
    beam.addColorStop(0, "rgba(255,250,235,.10)"); beam.addColorStop(1, "rgba(255,250,235,0)");
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w - W * .2, top * .8); ctx.lineTo(x - W * .2 - w, top * .8); ctx.closePath();
    ctx.fillStyle = beam; ctx.filter = `blur(${6 * scale}px)`; ctx.fill(); ctx.filter = "none";
  }
  ctx.restore();
}

/// `floor` is where the greeting starts, in canvas pixels: the picture is laid
/// out to end just above it.
function paint(canvas: HTMLCanvasElement, dark: boolean, floor: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, scale = W / 920, pal = PALETTES[dark ? "dark" : "light"], r = random(SEED);
  ctx.clearRect(0, 0, W, canvas.height);
  // the layout's height: its clip line (.47 of it) sits on the floor
  const H = Math.min(canvas.height, floor / .47);
  sky(ctx, W, H, pal, dark, r, scale);
  const branches: Branch[] = [], tips: Tip[] = [];
  // the near bough from the top-left, the far one from the top-right
  grow(r, [-W * .04, H * .05], .32, W * .34, 26 * scale, 4, branches, tips);
  const far = branches.length;
  grow(r, [W * 1.03, -H * .02], Math.PI - .55, W * .26, 17 * scale, 3, branches, tips);
  const limit = H * .42;
  ctx.save();
  // nothing reaches the greeting
  ctx.beginPath(); ctx.rect(0, 0, W, H * .47); ctx.clip();
  branches.forEach((b, i) => {
    if (b[0]!.y > limit) return;
    ctx.globalAlpha = i >= far ? .8 : 1;
    limb(ctx, b, pal);
  });
  ctx.globalAlpha = 1;
  // blossoms in clusters at twig ends and on spurs, buds among them
  for (const t of tips) {
    if (t.y > limit || t.y < -10 || t.x < -10 || t.x > W + 10) continue;
    const count = t.spur ? (r() < .5 ? 1 : 0) : (r() < .15 ? 0 : 1 + Math.floor(r() * 3.4));
    for (let i = 0; i < count; i++) {
      const fx = t.x + (r() - .5) * 26 * scale, fy = t.y + (r() - .5) * 22 * scale;
      const distant = r() < .3, size = (distant ? 5 + r() * 3 : 8 + r() * 8) * scale;
      ctx.save();
      if (distant) ctx.globalAlpha = .6;
      else {
        const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, size * 2.2);
        glow.addColorStop(0, pal.glow); glow.addColorStop(1, pal.glow.replace(/[\d.]+\)$/, "0)"));
        ctx.fillStyle = glow; ctx.fillRect(fx - size * 2.2, fy - size * 2.2, size * 4.4, size * 4.4);
      }
      blossom(ctx, r, fx, fy, size, r() * 6.28, .55 + r() * .45, pal, scale);
      ctx.restore();
    }
    if (r() < .5) bud(ctx, t.x, t.y, (6 + r() * 3) * scale, t.a + Math.PI / 2 + (r() - .5), pal, scale);
  }
  ctx.restore();
  // the lower edge fades out into the page behind
  ctx.save(); ctx.globalCompositeOperation = "destination-out";
  const fade = ctx.createLinearGradient(0, H * .36, 0, H * .5);
  fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = fade; ctx.fillRect(0, H * .36, W, H * .64);
  ctx.restore();
}

/// Mounts the blossom into `host` (sized by CSS). `floor` says how far down
/// the greeting starts, in CSS pixels from the host's top. Returns null without
/// a 2D canvas, and Home keeps its plain background.
export function mountSakura(host: HTMLElement, dark: boolean, floor: () => number): Sakura | null {
  const canvas = document.createElement("canvas");
  if (!canvas.getContext("2d")) return null;
  host.append(canvas);
  let shown = false, drawnFloor = -1, settle: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    const box = host.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
    drawnFloor = floor();
    paint(canvas, dark, Math.max(0, drawnFloor - 12) * dpr);
  };
  // While the window is being resized the picture stretches with it, and it is
  // drawn again at the new size once the window settles.
  const observer = new ResizeObserver(() => { clearTimeout(settle); settle = setTimeout(draw, 150); });
  return {
    pause() { shown = false; observer.disconnect(); clearTimeout(settle); },
    resume() { if (shown) return; shown = true; observer.observe(host); draw(); },
    setDark(next) { if (next === dark) return; dark = next; if (shown) draw(); },
    // Home's greeting moved (it grew a line, or lost one): end the picture above it again.
    refit() { if (shown && Math.abs(floor() - drawnFloor) > 4) draw(); },
  };
}
