// Helpers for a film drawn on one canvas (#97): a 2D camera of shots, a frame that starts from the same
// canvas state, grid paper, a label that lands and stays, and a hand-drawn line revealed by progress.
// The two canvas films of #87 each wrote these by hand (about a quarter of a 42 KB page), and the hand
// copies left canvas state between frames and labels on top of each other. Every function is a pure
// function of its inputs, so call them from film.draw with the time t.
(function () {
  if (!window.film) throw new Error("load kit/player.js before kit/sketch.js");
  var W = 1920,
    H = 1080;

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
  function prog(t, t0, d) {
    return d <= 0 ? (t >= t0 ? 1 : 0) : clamp((t - t0) / d, 0, 1);
  }
  function easeInOut(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
  }
  function easeOut(p) {
    return 1 - Math.pow(1 - p, 3);
  }

  // A camera from shots [{ t, dur, x, y, s, ease }]: from t, over dur seconds, it brings the point
  // (x, y) of the drawing to the middle of the screen at scale s. The scale changes by equal ratios per
  // unit of time (the eye reads zoom as a ratio); the position moves straight. dur 0 cuts on t, which is
  // how a drop or the final hit should change the picture: an eased zoom moves most a few frames after
  // it starts. ease is a function of 0..1 (default ease-in-out). Returns view(t) = { x, y, s }.
  function camera(shots) {
    var list = shots.slice().sort(function (a, b) {
      return a.t - b.t;
    });
    var first = list[0] || { x: W / 2, y: H / 2, s: 1 };
    return function (t) {
      var v = { x: first.x, y: first.y, s: first.s };
      for (var i = 1; i < list.length; i++) {
        var sh = list[i];
        if (t < sh.t) break;
        var p = (sh.ease || easeInOut)(prog(t, sh.t, sh.dur || 0));
        v = {
          x: v.x + (sh.x === undefined ? 0 : sh.x - v.x) * p,
          y: v.y + (sh.y === undefined ? 0 : sh.y - v.y) * p,
          s: v.s * Math.pow((sh.s === undefined ? v.s : sh.s) / v.s, p),
        };
      }
      return v;
    };
  }

  // Puts the view on ctx: drawing coordinates from here on are those of the drawing. k multiplies the
  // scale for this frame only (a push on a hit: 1 + 0.03 * beat.pulse(...)).
  function view(ctx, v, k) {
    var s = v.s * (k || 1);
    ctx.setTransform(s, 0, 0, s, W / 2 - v.x * s, H / 2 - v.y * s);
  }

  // Where the drawing point (x, y) shows on the screen under the view, in px: for text kept the same
  // size whatever the zoom.
  function onScreen(v, x, y) {
    return { x: (x - v.x) * v.s + W / 2, y: (y - v.y) * v.s + H / 2 };
  }

  // Starts a frame from the same canvas state every time, whatever the frame before left, and fills
  // the screen with `ground`. Without this, seeking back drew a different frame (#87).
  function begin(ctx, ground) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([]);
    ctx.filter = "none";
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, W, H);
  }

  // Grid paper over the part of the drawing the view shows. o: { ground, rule, major, step = 32,
  // every = 5 } (major is the color of every `every`-th line).
  function paper(ctx, v, o) {
    var step = o.step || 32,
      every = o.every || 5;
    var half = { x: W / 2 / v.s, y: H / 2 / v.s };
    var x0 = Math.floor((v.x - half.x) / step) * step,
      x1 = v.x + half.x,
      y0 = Math.floor((v.y - half.y) / step) * step,
      y1 = v.y + half.y;
    ctx.fillStyle = o.ground;
    ctx.fillRect(v.x - half.x, v.y - half.y, 2 * half.x, 2 * half.y);
    var w = 1 / v.s;
    for (var x = x0; x <= x1; x += step) {
      ctx.fillStyle = Math.round(x / step) % every === 0 ? o.major || o.rule : o.rule;
      ctx.fillRect(x, y0, w, y1 - y0);
    }
    for (var y = y0; y <= y1; y += step) {
      ctx.fillStyle = Math.round(y / step) % every === 0 ? o.major || o.rule : o.rule;
      ctx.fillRect(x0, y, x1 - x0, w);
    }
  }

  // A label that lands at t0 (drops `drop` px into place and fades in over 0.3 s) and leaves at t1
  // (fades out over 0.3 s). Text read on screen should stay at least 2 s. o: { size, color = "#1d2026",
  // weight = 700, font = "'Noto Sans JP', sans-serif", align = "left", base = "alphabetic", drop = 14 }.
  function label(ctx, text, x, y, t, t0, t1, o) {
    if (t < t0 || t > t1 + 0.3) return;
    var pin = easeOut(prog(t, t0, 0.3)),
      pout = 1 - prog(t, t1, 0.3);
    ctx.save();
    ctx.globalAlpha *= pin * pout;
    ctx.font = (o.weight || 700) + " " + o.size + "px " + (o.font || "'Noto Sans JP', sans-serif");
    ctx.fillStyle = o.color || "#1d2026";
    ctx.textAlign = o.align || "left";
    ctx.textBaseline = o.base || "alphabetic";
    ctx.fillText(text, x, y - (o.drop === undefined ? 14 : o.drop) * (1 - pin));
    ctx.restore();
  }

  // Seeded wobble, so a hand-drawn line has the same shape on every frame.
  function wobble(seed, i) {
    var x = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x) - 0.5;
  }

  // A hand-drawn polyline through `points` ([[x, y], ...]), drawn up to `progress` (0..1) of its
  // length. o: { width = 3, color = "#d23a2a", seed = 1, wobble = 0.5 (of the width) }.
  function line(ctx, points, progress, o) {
    if (progress <= 0 || points.length < 2) return;
    o = o || {};
    var width = o.width || 3,
      amp = (o.wobble === undefined ? 0.5 : o.wobble) * width,
      seed = o.seed || 1;
    var seg = [],
      len = 0;
    for (var i = 1; i < points.length; i++) {
      var d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      seg.push(d);
      len += d;
    }
    var target = len * clamp(progress, 0, 1),
      acc = 0;
    ctx.save();
    ctx.strokeStyle = o.color || "#d23a2a";
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (var k = 1; k < points.length; k++) {
      if (acc + seg[k - 1] <= target) {
        ctx.lineTo(points[k][0] + amp * wobble(seed, k), points[k][1] + amp * wobble(seed, k + 97));
        acc += seg[k - 1];
      } else {
        var q = (target - acc) / seg[k - 1];
        ctx.lineTo(
          points[k - 1][0] + (points[k][0] - points[k - 1][0]) * q,
          points[k - 1][1] + (points[k][1] - points[k - 1][1]) * q
        );
        break;
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // The points of a hand-drawn ellipse that goes round `turns` times (1.08 overlaps its start a little,
  // as a circle drawn in one stroke does).
  function ellipse(cx, cy, rx, ry, turns) {
    var pts = [],
      n = 48;
    for (var i = 0; i <= n * (turns || 1.08); i++) {
      var a = -Math.PI * 0.65 + (i / n) * Math.PI * 2;
      var r = 1 + 0.04 * Math.sin(i * 0.7);
      pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
    }
    return pts;
  }

  // The points of a hand-drawn box, its corners a little off as a quick pencil box is.
  function box(x, y, w, h) {
    return [
      [x, y],
      [x + w, y + 2],
      [x + w - 2, y + h],
      [x + 1, y + h - 1],
      [x + 3, y - 4],
    ];
  }

  window.sketch = {
    camera: camera,
    view: view,
    onScreen: onScreen,
    begin: begin,
    paper: paper,
    label: label,
    line: line,
    ellipse: ellipse,
    box: box,
  };
})();
