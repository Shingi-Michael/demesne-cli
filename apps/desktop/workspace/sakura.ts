/// Home's cherry blossom: two real boughs (CC0 photos from the WordPress photo
/// directory, sky cut away) over the top half of the start screen, with petals
/// resting in the air below them. It is a still picture, drawn when Home shows,
/// when the window settles at a new size and when the theme changes: the
/// falling petals and swaying boughs made the window redraw nonstop, which
/// slowed the whole app (and the Mac) and made full screen and resizing stutter.
import spawnPoints from "./sakura-spawns.json";

type Layer = {
  src: string; side: "left" | "right"; height: number; lift: number; inset: number; anchor: [number, number]; haze: number;
  spawns: number[][]; img?: HTMLImageElement; tx?: WebGLTexture; rect: [number, number, number, number]; aspect: number;
};
type Petal = { x: number; y: number; z: number; rx: number; ry: number; rz: number; kind: number };
export type Sakura = { pause(): void; resume(): void; setDark(dark: boolean): void };

const VS = `attribute vec2 p; uniform vec4 rect; varying vec2 v;
void main(){ v = rect.xy + p*rect.zw; gl_Position = vec4(v.x*2.-1., 1.-v.y*2., 0., 1.); }`;
const FS = `precision highp float;
varying vec2 v; uniform sampler2D img; uniform vec4 rect; uniform float dark, haze, flip;
uniform vec2 anchor; uniform vec3 sky; uniform float reachFrom;
float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n(vec2 p){ vec2 i = floor(p), f = fract(p), u = f*f*(3.-2.*f);
  return mix(mix(h(i), h(i+vec2(1,0)), u.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), u.x), u.y); }
void main(){
  vec2 src = (v - rect.xy) / rect.zw;
  vec4 col = texture2D(img, clamp(vec2(src.x, mix(src.y, 1. - src.y, flip)), .001, .999));
  // the photo's own edges dissolve unevenly, so no bough ends on a straight cut
  float ragged = (n(src * vec2(5., 9.)) - .5) * .2;
  float inner = anchor.x < .5 ? 1. - src.x : src.x;
  col *= smoothstep(0., .01, min(src.x, 1. - src.x)) * smoothstep(0., .005, src.y)
    * smoothstep(0., .22, 1. - src.y + ragged) * smoothstep(0., .22, inner + ragged);
  // the end away from where the bough enters thins out, never a cut edge
  float reach = anchor.x < .5 ? src.x : 1. - src.x;
  col *= 1. - smoothstep(reachFrom + n(src * 6.) * .14, .97 + reachFrom * .05, reach);
  vec3 rgb = col.rgb / max(col.a, .001);
  // pale sakura photographed against blue read grey: give them back their pink
  float bloom = smoothstep(.38, .82, dot(rgb, vec3(.333)));
  rgb = mix(rgb, rgb * vec3(1.05, .80, .87) + vec3(.03, 0., .015), bloom);
  rgb = mix(rgb, mix(rgb, vec3(.40, .31, .30), mix(.55, .35, dark)) + .10 * (1. - dark), (1. - bloom) * .7);
  // by night the bark sinks and the blossoms keep a moonlit glow
  rgb = mix(rgb, rgb * mix(vec3(.42, .36, .42), vec3(.92, .82, .88), bloom), dark);
  rgb = mix(rgb, sky, haze);
  // a ragged lower edge, never a level line above the greeting
  float a = col.a * (1. - smoothstep(.85, 1.1, v.y / .5 + (n(v * vec2(7., 3.)) - .5) * .25)) * (1. - haze * .3);
  gl_FragColor = vec4(rgb * a, a);
}`;
const TINTS = [["#e59ab2", "#f7cdd9", "#fff4f7"], ["#dc86a2", "#f3bccc", "#fde8ee"], ["#e9aec1", "#fadbe4", "#ffffff"]];
const PETAL = "M0 22 C-15 12 -17 -8 -9 -19 C-6 -23 -3 -22 0 -17 C3 -22 6 -23 9 -19 C17 -8 15 12 0 22Z";

function petalSprite(tint: string[], blur: number) {
  const c = document.createElement("canvas"); c.width = c.height = 72;
  const x = c.getContext("2d")!;
  x.filter = blur ? `blur(${blur}px)` : "none";
  x.translate(36, 36);
  const g = x.createLinearGradient(0, 22, 0, -22);
  g.addColorStop(0, tint[0]!); g.addColorStop(.4, tint[1]!); g.addColorStop(1, tint[2]!);
  x.fillStyle = g; x.fill(new Path2D(PETAL));
  x.globalAlpha = .16; x.strokeStyle = tint[0]!; x.lineWidth = .8;
  x.beginPath(); x.moveTo(0, 20); x.quadraticCurveTo(1, 0, 0, -15); x.stroke();
  return c;
}

/// Mounts the blossom into `host` (sized by CSS). Returns null when WebGL is
/// unavailable, and Home simply keeps its plain background.
export function mountSakura(host: HTMLElement, dark: boolean): Sakura | null {
  const glc = document.createElement("canvas"), pc = document.createElement("canvas");
  glc.className = "sk-tree"; pc.className = "sk-petals";
  const gl = glc.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
  const ctx = pc.getContext("2d");
  if (!gl || !ctx) return null;
  host.append(glc, pc);
  const shader = (type: number, source: string) => {
    const s = gl.createShader(type)!; gl.shaderSource(s, source); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uniforms = new Map<string, WebGLUniformLocation | null>();
  const u = (name: string) => { if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(prog, name)); return uniforms.get(name)!; };
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  // The far bough comes in from the right, soft and hazed; the near one hangs
  // from the top-left corner (its photo turned over, so the thick limb is in
  // view instead of below the fade).
  const bough = (src: string, side: Layer["side"], height: number, lift: number, inset: number, anchor: [number, number], haze: number, spawns: number[][]): Layer =>
    ({ src, side, height, lift, inset, anchor, haze, spawns, rect: [0, 0, 1, 1], aspect: 1 });
  const layers = [
    bough("assets/sakura/far.webp", "right", 1.15, .02, 0, [1, .2], .1, spawnPoints.far),
    bough("assets/sakura/near.webp", "left", 1.1, .06, .03, [0, .22], 0, spawnPoints.near),
  ];
  let W = 0, H = 0, PH = 0, dpr = 1, darkness = dark ? 1 : 0, shown = false;
  function place() {
    for (const l of layers) {
      const hh = l.height * .5, ww = hh * PH * l.aspect / Math.max(W, 1);
      l.rect = [l.side === "left" ? -l.inset * ww : 1 - ww + l.inset * ww, -l.lift * hh, ww, hh];
    }
  }
  for (const l of layers) {
    const img = new Image();
    img.onload = () => {
      l.aspect = img.naturalWidth / img.naturalHeight; l.img = img;
      l.tx = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, l.tx);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      for (const [k, value] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
        gl.texParameteri(gl.TEXTURE_2D, k, value);
      place();
      if (shown) draw();
    };
    img.src = l.src;
  }

  const sprites = TINTS.map((tint) => [petalSprite(tint, 0), petalSprite(tint, 1.4), petalSprite(tint, 3.4)]);
  const petals: Petal[] = [];
  /// A petal let go from a blossom on one of the boughs, somewhere below it.
  function spawn() {
    const l = Math.random() < .8 ? layers[1]! : layers[0]!;
    const [su = 0, sv = 0] = l.spawns[(Math.random() * l.spawns.length) | 0] ?? [];
    const x = (l.rect[0] + su * l.rect[2]) * W, y = (l.rect[1] + (l.side === "left" ? 1 - sv : sv) * l.rect[3]) * PH;
    if (x < -20 || x > W + 20 || y < -10 || y > H * .95) return;
    petals.push({ x, y: y + Math.random() * PH * .5, z: .55 + Math.random() ** 1.7 * 1.5, rx: Math.random() * 6.28, ry: Math.random() * 6.28, rz: Math.random() * 6.28, kind: (Math.random() * 3) | 0 });
  }

  function resize() {
    const r = host.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; PH = r.height; H = PH * .55;
    glc.width = pc.width = Math.round(W * dpr); glc.height = pc.height = Math.round(PH * dpr);
    place();
    draw();
  }
  // While the window is being resized the canvases stretch with it, and they
  // are rebuilt at the new size once it settles: rebuilding them on every
  // step cleared them (a flash each step) and reallocated two retina-sized
  // buffers many times a second, which made resizing stutter.
  let settle: ReturnType<typeof setTimeout> | undefined;
  const observer = new ResizeObserver(() => { clearTimeout(settle); settle = setTimeout(resize, 150); });

  function draw() {
    gl!.viewport(0, 0, glc.width, glc.height); gl!.clearColor(0, 0, 0, 0); gl!.clear(gl!.COLOR_BUFFER_BIT);
    gl!.uniform1f(u("dark"), darkness);
    gl!.uniform3f(u("sky"), .115 * darkness + .985 * (1 - darkness), .085 * darkness + .935 * (1 - darkness), .11 * darkness + .95 * (1 - darkness));
    gl!.uniform1i(u("img"), 0);
    for (const l of layers) {
      if (!l.tx) continue;
      gl!.activeTexture(gl!.TEXTURE0); gl!.bindTexture(gl!.TEXTURE_2D, l.tx);
      gl!.uniform4f(u("rect"), ...l.rect);
      gl!.uniform2f(u("anchor"), ...l.anchor); gl!.uniform1f(u("haze"), l.haze);
      gl!.uniform1f(u("flip"), l.side === "left" ? 1 : 0); gl!.uniform1f(u("reachFrom"), l.side === "left" ? .72 : .8);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
    }
    // The petals are scattered once, when both boughs are in and the size is known.
    if (!petals.length && layers.every((l) => l.img) && W) for (let i = 0; i < 18; i++) spawn();
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); ctx!.clearRect(0, 0, W, PH);
    const edge = PH * .86;
    for (let i = petals.length - 1; i >= 0; i--) {
      const p = petals[i]!;
      if (p.y > edge + 30 || p.x > W + 60 || p.x < -80) continue;
      const fade = 1 - Math.max(0, Math.min(1, (p.y - edge * .7) / (edge * .3)));
      const size = (p.z > 1.75 ? 20 : 15) * p.z, sx = Math.cos(p.ry), sy = Math.cos(p.rx);
      const blur = p.z > 1.75 ? 2 : p.z < .72 ? 1 : 0;
      ctx!.globalAlpha = fade * (p.z < .72 ? .6 : p.z > 1.75 ? .8 : .95) * (blur === 2 ? 1 : .7 + .3 * Math.abs(sx * sy)) * (darkness > .5 ? .92 : 1);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0); ctx!.translate(p.x, p.y); ctx!.rotate(p.rz);
      ctx!.scale((Math.abs(sx) < .08 ? .08 : sx) * size / 44, (Math.abs(sy) < .08 ? .08 : sy) * size / 44);
      ctx!.drawImage(sprites[p.kind]![blur]!, -36, -36);
    }
    ctx!.globalAlpha = 1;
  }
  return {
    pause() { shown = false; observer.disconnect(); clearTimeout(settle); },
    resume() {
      if (shown) return;
      shown = true; observer.observe(host); resize();
    },
    setDark(next) { darkness = next ? 1 : 0; if (shown) draw(); },
  };
}
