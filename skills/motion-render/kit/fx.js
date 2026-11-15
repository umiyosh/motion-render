// Drawing helpers for an html film that draws with code (canvas 2D, WebGL, many particles), where a
// GSAP timeline is not enough. Every value here is a pure function of its inputs: a film calls them
// from film.draw(fn) with the time t, and the same t always gives the same frame, however the film
// got to it. Math.random and the clock would break that; use fx.rand and t instead.
(function () {
  if (!window.film) throw new Error("load kit/player.js before kit/fx.js");
  var W = 1920,
    H = 1080;

  // A seeded random generator (mulberry32): fx.rand(7)() gives the same sequence on every frame.
  function rand(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var x = Math.imul(a ^ (a >>> 15), 1 | a);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth value noise in 3D (lattice hash, quintic fade), in -1..1. Pass t as one coordinate to
  // make a field that flows over time.
  function hash(x, y, z) {
    var h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1440670441);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function fade(p) {
    return p * p * p * (p * (p * 6 - 15) + 10);
  }
  function lerp(a, b, p) {
    return a + (b - a) * p;
  }
  function noise(x, y, z) {
    z = z || 0;
    var xi = Math.floor(x),
      yi = Math.floor(y),
      zi = Math.floor(z),
      u = fade(x - xi),
      v = fade(y - yi),
      w = fade(z - zi);
    function c(dx, dy, dz) {
      return hash(xi + dx, yi + dy, zi + dz);
    }
    var x00 = lerp(c(0, 0, 0), c(1, 0, 0), u),
      x10 = lerp(c(0, 1, 0), c(1, 1, 0), u),
      x01 = lerp(c(0, 0, 1), c(1, 0, 1), u),
      x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
    return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
  }
  // Noise summed over `octaves` finer layers: rougher, more natural detail.
  function fbm(x, y, z, octaves) {
    var s = 0,
      amp = 0.5,
      f = 1;
    for (var i = 0; i < (octaves || 4); i++) {
      s += amp * noise(x * f, y * f, (z || 0) * f);
      amp *= 0.5;
      f *= 2;
    }
    return s;
  }

  // Where a damped spring released at time t0 is at time t, from 0 toward 1: overshoots and settles
  // like a physical object, with no state between frames. o: { freq = 2.2 (Hz), damp = 0.35 }.
  function spring(t, t0, o) {
    if (t <= t0) return 0;
    o = o || {};
    var w = 2 * Math.PI * (o.freq || 2.2),
      z = o.damp === undefined ? 0.35 : o.damp,
      s = t - t0;
    if (z >= 1) return 1 - (1 + w * s) * Math.exp(-w * s);
    var wd = w * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w * s) * (Math.cos(wd * s) + ((z * w) / wd) * Math.sin(wd * s));
  }

  // A value that follows a list of targets [[t0, value], ...] (in time order), settling on each new
  // target without overshoot (a critically damped spring per change, summed): an object that is
  // sent somewhere new several times stays a pure function of t. o: { freq = 3 (Hz) }.
  function follow(t, targets, o) {
    var w = 2 * Math.PI * ((o && o.freq) || 3),
      v = targets.length ? targets[0][1] : 0;
    for (var i = 1; i < targets.length; i++) {
      var s = t - targets[i][0];
      if (s <= 0) break;
      v += (targets[i][1] - targets[i - 1][1]) * (1 - (1 + w * s) * Math.exp(-w * s));
    }
    return v;
  }

  function prog(t, t0, d) {
    if (t <= t0) return 0;
    return d > 0 ? Math.min(1, (t - t0) / d) : 1;
  }
  // The default ease of a camera move: it starts and stops gently (cubic in-out).
  function inOut(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }

  // A magnification going from s0 to s1 over dur s from t0, by equal ratios in equal times. The eye
  // reads a change of size as a ratio, so a scale run at a steady rate seems to slow down as it
  // grows (1 to 4: 2 times in the first quarter, 1.33 times in the last). ez: an ease (p => p).
  function zoom(t, t0, s0, s1, dur, ez) {
    return s0 * Math.pow(s1 / s0, (ez || inOut)(prog(t, t0, dur)));
  }

  // What a camera shows: the point (x, y) of the layer it moves, in px of the layer at rest, at the
  // center of the frame, magnified s times.
  var REST = { x: W / 2, y: H / 2, s: 1 };
  var RHO = Math.SQRT2;

  // A move from view a to view b, p of the way (0..1). The plain move is a zoom about the one point
  // of the layer that stays put on the frame, so everything grows away from (or toward) it and
  // nothing swings. With fly, the move follows the path of van Wijk and Nuij ("Smooth and efficient
  // zooming and panning", IEEE InfoVis 2003): it pulls out while it travels and pushes in at the end,
  // so a move to something far away never slides the ground past faster than the eye can follow.
  function between(a, b, p, fly) {
    var dx = b.x - a.x,
      dy = b.y - a.y,
      d = Math.sqrt(dx * dx + dy * dy);
    // The far end lands on b exactly: the formulas leave it a hair off.
    if (p >= 1) return { x: b.x, y: b.y, s: b.s };
    if (fly && d > 1e-6) return flyAt(a, b, dx, dy, d, p);
    var s = a.s * Math.pow(b.s / a.s, p);
    if (Math.abs(a.s - b.s) < 1e-9) return { x: a.x + dx * p, y: a.y + dy * p, s: s };
    // The fixed point F shows at the same place in both views: (F - a) * a.s = (F - b) * b.s.
    var px = (a.x * a.s - b.x * b.s) / (a.s - b.s),
      py = (a.y * a.s - b.y * b.s) / (a.s - b.s);
    return { x: px - ((px - a.x) * a.s) / s, y: py - ((py - a.y) * a.s) / s, s: s };
  }
  // The optimal path, with the visible width w = W / s and u the distance travelled toward b.
  function flyAt(a, b, dx, dy, d, p) {
    var w0 = W / a.s,
      w1 = W / b.s,
      r2 = RHO * RHO,
      b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d * d) / (2 * w0 * r2 * d),
      b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d * d) / (2 * w1 * r2 * d),
      r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0),
      r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1),
      s = (p * (r1 - r0)) / RHO,
      u = (w0 / r2) * (Math.cosh(r0) * Math.tanh(RHO * s + r0) - Math.sinh(r0)),
      w = (w0 * Math.cosh(r0)) / Math.cosh(RHO * s + r0);
    return { x: a.x + (dx * u) / d, y: a.y + (dy * u) / d, s: W / w };
  }

  // A camera over one layer of the film: shots [{ t, x, y, s, dur, ease, fly }], each a move that
  // starts at t and, over dur s, comes to show (x, y) magnified s times (x, y left out: where it is
  // looking). Before the first shot it is at rest; a shot that starts before the one before it has
  // landed takes over from where that one is. Returns draw(t, k) for film.draw: it places the layer
  // and returns the view it shows { x, y, s }; k multiplies the magnification on that frame (a notch
  // per kick with beat.zoomSteps, a punch on a hit). Words to read go outside the layer.
  function camera(sel, shots) {
    var el = typeof sel === "string" ? document.querySelector(sel) : sel;
    if (!el) throw new Error("fx.camera: no element at " + sel);
    // Shapes in the layer may run off the frame when it pushes in; the layout check still stops text.
    el.setAttribute("data-camera", "");
    el.style.transformOrigin = "0 0";
    var list = shots.slice().sort(function (a, b) {
      return a.t - b.t;
    });
    function view(t) {
      var v = REST;
      for (var i = 0; i < list.length && list[i].t <= t; i++) {
        var m = list[i],
          next = list[i + 1],
          until = next && next.t <= t ? next.t : t,
          to = {
            x: m.x === undefined ? v.x : m.x,
            y: m.y === undefined ? v.y : m.y,
            s: m.s || v.s,
          };
        v = between(v, to, (m.ease || inOut)(prog(until, m.t, m.dur)), m.fly);
      }
      return v;
    }
    // The frame never looks past the layer's edges, where the set ends: a view that would is slid
    // back inside, and a layer smaller than the view is kept at its center.
    var lw = el.offsetWidth || W,
      lh = el.offsetHeight || H;
    function inside(c, half, size) {
      return half * 2 >= size ? size / 2 : Math.min(Math.max(c, half), size - half);
    }
    return function (t, k) {
      var v = view(t),
        s = v.s * (k === undefined ? 1 : k),
        x = inside(v.x, W / 2 / s, lw),
        y = inside(v.y, H / 2 / s, lh);
      el.style.transform =
        "translate(" + (W / 2 - x * s) + "px," + (H / 2 - y * s) + "px) scale(" + s + ")";
      return { x: x, y: y, s: s };
    };
  }

  // Where the point (x, y) of a camera's layer shows on the frame, in px, for the view a camera's
  // draw returned: to keep a word outside the layer next to the thing it names.
  function onFrame(view, x, y) {
    return { x: (x - view.x) * view.s + W / 2, y: (y - view.y) * view.s + H / 2 };
  }

  // A hand-drawn line that boils: the points of `pts` ([[x, y], ...]) moved by up to `amp` px,
  // with a new wobble `rate` times a second (a held drawing still feels drawn by hand).
  function boil(pts, t, amp, rate) {
    var phase = Math.floor(t * (rate || 8));
    return pts.map(function (p, i) {
      return [
        p[0] + (amp || 1.5) * noise(i * 0.37, phase * 1.7, 11),
        p[1] + (amp || 1.5) * noise(i * 0.37, phase * 1.7, 29),
      ];
    });
  }

  // Where a point of a three.js scene appears on the frame, in px: for HTML labels that ride on
  // 3D objects. `v` is a THREE.Vector3 in world space.
  function project(v, camera) {
    // The camera's matrices follow its position only when the scene is rendered: a film that moves
    // the camera and asks where a point shows before rendering would get the last frame's answer.
    camera.updateMatrixWorld();
    var p = v.clone().project(camera);
    return { x: ((p.x + 1) / 2) * W, y: ((1 - p.y) / 2) * H, behind: p.z > 1 };
  }

  // A <canvas> filling the frame (1920 x 1080 px) for 2D drawing; returns its context. Call it once,
  // outside film.draw, and clear or repaint the whole canvas in every draw.
  function canvas(sel) {
    var c = document.querySelector(sel);
    if (!(c instanceof HTMLCanvasElement)) throw new Error("fx.canvas: no <canvas> at " + sel);
    c.width = W;
    c.height = H;
    return c.getContext("2d");
  }

  // A picture drawn once and kept: draw(ctx) paints a w x h canvas the first time `key` is asked
  // for, and later calls return the same canvas, to drawImage on every frame. Things whose shape
  // does not change (a card with its soft shadow, a strip of patterned paper) cost a shadow blur or
  // a pattern fill once instead of on every frame, which made a film draw 2 to 3 times slower.
  var sprites = {};
  function sprite(key, w, h, draw) {
    if (!sprites[key]) {
      var c = document.createElement("canvas");
      c.width = Math.ceil(w);
      c.height = Math.ceil(h);
      draw(c.getContext("2d"));
      sprites[key] = c;
    }
    return sprites[key];
  }

  // Film grain over a 2D context: a fresh but repeatable pattern per frame (seeded by the frame
  // number), so a still frame is never dead flat. amount 0..1 (0.06 is subtle).
  function grain(ctx, t, amount) {
    var r = rand(Math.floor(t * 60) + 1),
      a = amount === undefined ? 0.06 : amount,
      n = 2400;
    ctx.save();
    for (var i = 0; i < n; i++) {
      var v = r() < 0.5 ? 0 : 255;
      ctx.fillStyle = "rgba(" + v + "," + v + "," + v + "," + a * r() + ")";
      ctx.fillRect(r() * W, r() * H, 1 + r() * 2, 1 + r() * 2);
    }
    ctx.restore();
  }

  // A three.js renderer on a <canvas> filling the frame, with a scene and a perspective camera.
  // Needs kit/three.min.js. Render it from film.draw: set every object and the camera from t, then
  // call render(). o: { fov = 40, near = 0.1, far = 1000, alpha = true }.
  function three(sel, o) {
    var T = window.THREE;
    if (!T) throw new Error("load kit/three.min.js before calling fx.three");
    o = o || {};
    var c = document.querySelector(sel);
    if (!(c instanceof HTMLCanvasElement)) throw new Error("fx.three: no <canvas> at " + sel);
    var renderer = new T.WebGLRenderer({
      canvas: c,
      antialias: true,
      alpha: o.alpha !== false,
      // The frame is read back after the draw; without this the canvas can come back empty.
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    var scene = new T.Scene(),
      camera = new T.PerspectiveCamera(o.fov || 40, W / H, o.near || 0.1, o.far || 1000);
    return {
      renderer: renderer,
      scene: scene,
      camera: camera,
      render: function () {
        renderer.render(scene, camera);
      },
    };
  }

  window.fx = {
    rand: rand,
    noise: noise,
    fbm: fbm,
    spring: spring,
    follow: follow,
    zoom: zoom,
    camera: camera,
    onFrame: onFrame,
    boil: boil,
    project: project,
    canvas: canvas,
    sprite: sprite,
    grain: grain,
    three: three,
  };
})();
