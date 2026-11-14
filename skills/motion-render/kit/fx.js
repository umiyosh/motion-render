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
    boil: boil,
    project: project,
    canvas: canvas,
    sprite: sprite,
    grain: grain,
    three: three,
  };
})();
