/// Home's cherry blossom: a still anime print of two boughs reaching in from
/// the top corners. It is drawn once, and again only when the panel settles
/// at a new size or the theme changes, so nothing runs while Home sits there.

type Rand = () => number;
type Tip = { x: number; y: number; a: number; spur?: boolean };
type Point = { x: number; y: number; w: number };
type Palette = { sky: [string, string, string]; bark: string; rim: string; petal: [string, string]; tip: string; line: string; center: string; stamen: string; bud: string; glow: string };

const PALETTES: Record<"dark" | "light", Palette> = {
  dark: { sky: ["#141436", "#2c2150", "#3d2a55"], bark: "#2a1b2c", rim: "rgba(190,170,255,.55)", petal: ["#ffd9e6", "#f59bbb"], tip: "#fff2f6", line: "#a8406a", center: "#d6336c", stamen: "#ffe08a", bud: "#ee5f8e", glow: "rgba(255,170,205,.22)" },
  light: { sky: ["#7fc3ee", "#bfe0f6", "#fbe1ea"], bark: "#3a2530", rim: "rgba(255,240,230,.75)", petal: ["#ffe3ec", "#f7a5c0"], tip: "#ffffff", line: "#c2507a", center: "#e0457a", stamen: "#f2b84b", bud: "#f0628f", glow: "rgba(255,255,255,.55)" },
};

function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A bough: each branch is a polyline with widths, grown recursively.
function grow(r: Rand, start: [number, number], angle: number, length: number, width: number, depth: number, out: Point[][], tips: Tip[]) {
  const pts: Point[] = [];
  let [x, y] = start, a = angle;
  const steps = Math.max(4, Math.round(length / 14)), bend = (r() - .5) * .5;
  for (let i = 0; i <= steps; i++) {
    pts.push({ x, y, w: width * (1 - i / steps * .55) });
    a += bend / steps + (r() - .5) * .16;
    x += Math.cos(a) * length / steps; y += Math.sin(a) * length / steps;
  }
  out.push(pts);
  const end = pts[pts.length - 1]!;
  if (depth <= 0 || width < 1.1) { tips.push({ x: end.x, y: end.y, a }); return; }
  const shoots = depth > 2 ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2);
  for (let k = 0; k < shoots; k++) {
    const at = pts[Math.floor((.35 + r() * .55) * (pts.length - 1))]!, side = r() < .5 ? -1 : 1;
    grow(r, [at.x, at.y], a + side * (.45 + r() * .55), length * (.42 + r() * .25), at.w * (.5 + r() * .15), depth - 1, out, tips);
  }
  grow(r, [end.x, end.y], a + (r() - .5) * .35, length * (.55 + r() * .2), end.w * .78, depth - 1, out, tips);
  // Little spurs where flowers sit.
  for (let k = 0; k < 3; k++) {
    const at = pts[Math.floor(r() * pts.length)]!;
    tips.push({ x: at.x, y: at.y, a: a + (r() - .5) * 2, spur: true });
  }
}

// A filled, tapered limb with a rim of light along its upper edge.
function limb(ctx: CanvasRenderingContext2D, p: Point[], pal: Palette) {
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

// One petal: rounded, with the cherry's notch at its tip.
function petalPath(ctx: CanvasRenderingContext2D, len: number, wid: number) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid * .9, -len * .15, wid * 1.05, -len * .78, wid * .32, -len * .98);
  ctx.quadraticCurveTo(wid * .1, -len * .86, 0, -len * .8);
  ctx.quadraticCurveTo(-wid * .1, -len * .86, -wid * .32, -len * .98);
  ctx.bezierCurveTo(-wid * 1.05, -len * .78, -wid * .9, -len * .15, 0, 0);
  ctx.closePath();
}

function flower(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, rot: number, tilt: number, pal: Palette, r: Rand, scale: number) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot); ctx.scale(1, tilt);
  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI * 2 / 5 + (r() - .5) * .18);
    const len = size * (.92 + r() * .16), wid = size * .52;
    petalPath(ctx, len, wid);
    // Flat cel tones: a deeper base, a pale upper half, a white glint, a rose line.
    ctx.fillStyle = pal.petal[1]; ctx.fill();
    ctx.save(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(0, -len * .72, wid * .95, len * .5, 0, 0, Math.PI * 2); ctx.fillStyle = pal.petal[0]; ctx.fill();
    ctx.beginPath(); ctx.ellipse(-wid * .28, -len * .78, wid * .16, len * .1, -.4, 0, Math.PI * 2); ctx.fillStyle = pal.tip; ctx.fill();
    ctx.restore();
    ctx.strokeStyle = pal.line; ctx.lineWidth = .9 * scale; ctx.stroke();
    ctx.restore();
  }
  ctx.beginPath(); ctx.arc(0, 0, size * .2, 0, Math.PI * 2); ctx.fillStyle = pal.center; ctx.globalAlpha *= .9; ctx.fill(); ctx.globalAlpha /= .9;
  const stamens = 9 + Math.floor(r() * 5);
  for (let i = 0; i < stamens; i++) {
    const a = r() * Math.PI * 2, l = size * (.35 + r() * .2);
    ctx.save(); ctx.globalAlpha *= .55;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
    ctx.strokeStyle = pal.center; ctx.lineWidth = .55 * scale; ctx.stroke();
    ctx.restore();
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

function sky(ctx: CanvasRenderingContext2D, W: number, H: number, pal: Palette, dark: boolean, r: Rand, scale: number) {
  const top = H * .55, g = ctx.createLinearGradient(0, 0, 0, top);
  g.addColorStop(0, pal.sky[0]); g.addColorStop(.45, pal.sky[1]); g.addColorStop(.75, pal.sky[2]); g.addColorStop(1, `${pal.sky[2]}00`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, top);
  if (dark) {
    // Stars, a few with four points, and a big moon with its halo.
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
  // Cel clouds, a white body over a pale blue underside.
  const cloud = (cx: number, cy: number, w: number) => {
    const puffs = [[0, 0, .32], [-.3, .08, .22], [.3, .07, .24], [-.12, -.12, .24], [.16, -.1, .2]] as const;
    ctx.fillStyle = "#dbe9f7";
    for (const [dx, dy, rr] of puffs) { ctx.beginPath(); ctx.arc(cx + dx * w, cy + dy * w + w * .05, rr * w, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = "#ffffff";
    for (const [dx, dy, rr] of puffs) { ctx.beginPath(); ctx.arc(cx + dx * w, cy + dy * w - w * .02, rr * w * .94, 0, Math.PI * 2); ctx.fill(); }
  };
  cloud(W * .58, H * .2, W * .2); cloud(W * .86, H * .3, W * .13); cloud(W * .3, H * .27, W * .1);
  // Soft beams of light that fade before the greeting.
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 3; i++) {
    const x = W * (.6 + i * .14), w = W * (.04 + i * .015), beam = ctx.createLinearGradient(0, 0, 0, top * .8);
    beam.addColorStop(0, "rgba(255,250,235,.10)"); beam.addColorStop(1, "rgba(255,250,235,0)");
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + w, 0); ctx.lineTo(x + w - W * .2, top * .8); ctx.lineTo(x - W * .2 - w, top * .8); ctx.closePath();
    ctx.fillStyle = beam; ctx.filter = `blur(${6 * scale}px)`; ctx.fill(); ctx.filter = "none";
  }
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, W: number, H: number, dark: boolean) {
  const scale = W / 920, pal = PALETTES[dark ? "dark" : "light"], r = rng(3), limit = H * .42;
  sky(ctx, W, H, pal, dark, r, scale);
  const branches: Point[][] = [], tips: Tip[] = [];
  grow(r, [-W * .04, H * .05], .32, W * .34, 26 * scale, 4, branches, tips);
  const farFrom = branches.length;
  grow(r, [W * 1.03, -H * .02], Math.PI - .55, W * .26, 17 * scale, 3, branches, tips);
  ctx.save();
  // Nothing reaches the greeting.
  ctx.beginPath(); ctx.rect(0, 0, W, H * .47); ctx.clip();
  branches.forEach((b, i) => {
    if (b[0]!.y > limit) return;
    ctx.globalAlpha = i >= farFrom ? .8 : 1;
    limb(ctx, b, pal);
  });
  ctx.globalAlpha = 1;
  for (const t of tips) {
    if (t.y > limit || t.y < -10 || t.x < -10 || t.x > W + 10) continue;
    const count = t.spur ? (r() < .5 ? 1 : 0) : (r() < .15 ? 0 : 1 + Math.floor(r() * 3.4));
    for (let i = 0; i < count; i++) {
      const fx = t.x + (r() - .5) * 26 * scale, fy = t.y + (r() - .5) * 22 * scale, far = r() < .3, size = (far ? 5 + r() * 3 : 8 + r() * 8) * scale;
      ctx.save();
      if (far) ctx.globalAlpha = .6;
      else {
        const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, size * 2.2);
        glow.addColorStop(0, pal.glow); glow.addColorStop(1, pal.glow.replace(/[\d.]+\)$/, "0)"));
        ctx.fillStyle = glow; ctx.fillRect(fx - size * 2.2, fy - size * 2.2, size * 4.4, size * 4.4);
      }
      flower(ctx, fx, fy, size, r() * 6.28, .55 + r() * .45, pal, r, scale);
      ctx.restore();
    }
    if (r() < .5) bud(ctx, t.x, t.y, (6 + r() * 3) * scale, t.a + Math.PI / 2 + (r() - .5), pal, scale);
  }
  ctx.restore();
  // The lower edge fades out, so the glass shows through below the picture.
  const fade = ctx.createLinearGradient(0, H * .36, 0, H * .5);
  fade.addColorStop(0, "rgba(0,0,0,0)"); fade.addColorStop(1, "#000");
  ctx.save(); ctx.globalCompositeOperation = "destination-out"; ctx.fillStyle = fade; ctx.fillRect(0, H * .36, W, ctx.canvas.height); ctx.restore();
}

export interface Blossom { setDark(dark: boolean): void }

/// Mounts the picture into `host` (sized by CSS), kept above the greeting:
/// `clear` says how far down the host, in CSS pixels, the greeting starts.
/// Returns null without a 2D canvas.
export function mountBlossom(host: HTMLElement, dark: boolean, clear: () => number): Blossom | null {
  const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
  if (!ctx) return null;
  host.append(canvas);
  let wanted = dark, drawn: string | null = null, settle = 0;
  const paint = () => {
    const box = host.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), W = Math.round(box.width * dpr), H = Math.round(box.height * dpr), picture = Math.round(Math.max(clear(), 24) * dpr * 2), key = `${W}x${H}:${picture}:${wanted}`;
    if (!W || !H || key === drawn) return;
    drawn = key; canvas.width = W; canvas.height = H;
    draw(ctx, W, picture, wanted);
  };
  // A resize stretches the last picture; it is redrawn once the window settles.
  new ResizeObserver(() => { clearTimeout(settle); settle = window.setTimeout(paint, 150); }).observe(host);
  paint();
  return { setDark(next) { wanted = next; paint(); } };
}
