// Beat-synced motion for an html film. kit/timing.js carries the film's tempo, the sections of the
// script and every drum hit of the rendered score (motion-render score); this file turns them into
// values of the time t, for film.draw(fn). Nothing here keeps state between frames, so a frame is
// the same however the film got to it.
(function () {
  var T = window.__timing,
    H = window.__hits || { hits: [] };
  if (!T || !window.film)
    throw new Error("load kit/timing.js and kit/player.js before kit/beat.js");
  var bpm = T.bpm || 120,
    bar = 240 / bpm;
  // A hit is shown half a 60 fps frame before it sounds: a picture slightly early reads as on time,
  // late reads as late (ITU-R BT.1359).
  var E = 0.008;
  var hits = (H.hits || []).slice().sort(function (a, b) {
    return a.t - b.t;
  });

  function prog(t, t0, d) {
    if (t < t0) return 0;
    return d > 0 ? Math.min(1, (t - t0) / d) : 1;
  }
  function back(s) {
    return function (p) {
      var q = p - 1;
      return q * q * ((s + 1) * q + s) + 1;
    };
  }
  // GSAP's curves by the same names: power1 = quad, power2 = cubic, power3 = quart.
  var ease = {
    none: function (p) {
      return p;
    },
    in1: function (p) {
      return p * p;
    },
    in2: function (p) {
      return p * p * p;
    },
    in3: function (p) {
      return p * p * p * p;
    },
    out1: function (p) {
      return 1 - (1 - p) * (1 - p);
    },
    out2: function (p) {
      return 1 - Math.pow(1 - p, 3);
    },
    out3: function (p) {
      return 1 - Math.pow(1 - p, 4);
    },
    inOut2: function (p) {
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    },
    expo: function (p) {
      return p >= 1 ? 1 : 1 - Math.pow(2, -10 * p);
    },
    back: back,
  };

  // The hits from `list` (sorted by t) that have been shown by t: the index of the last one, or -1.
  function reached(list, t) {
    var lo = 0,
      hi = list.length - 1,
      r = -1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (list[m].t - E <= t) {
        r = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return r;
  }

  // Hits of the score: o.k a kind or a list of kinds ("kick", "snare", "rim", "ghost", "hat"),
  // o.from / o.to in seconds, o.min the least strength (0..1).
  function pick(o) {
    o = o || {};
    var kinds = o.k ? [].concat(o.k) : null,
      from = o.from === undefined ? -Infinity : o.from,
      to = o.to === undefined ? Infinity : o.to;
    return hits.filter(function (h) {
      return (!kinds || kinds.indexOf(h.k) >= 0) && h.t >= from && h.t < to && h.v >= (o.min || 0);
    });
  }

  // 1 on the frame a hit of `list` lands, falling to 0 over `dur` s, times the hit's strength:
  // a value to add to a resting one (scale = 1 + 0.2 * beat.pulse(kicks, t, 0.2)).
  function pulse(list, t, dur, ez) {
    var i = reached(list, t);
    if (i < 0) return 0;
    var h = list[i],
      p = prog(t, h.t - E, dur);
    return p >= 1 ? 0 : (1 - (ez || ease.out2)(p)) * (h.v === undefined ? 1 : h.v);
  }

  // Seconds since the latest hit of `list` was shown, or Infinity before the first: for a thing that
  // goes off once per hit (a spark gone within an 8th: o = 1 - beat.since(snares, t) / (30 / bpm)).
  function since(list, t) {
    var i = reached(list, t);
    return i < 0 ? Infinity : t - (list[i].t - E);
  }

  // How far a value has stepped: one step per hit of `list`, each eased over `dur` s. 0 before the
  // first hit, list.length after the last (a meter that fills a cell per hit, a camera that pushes in
  // a notch per kick of a build).
  function steps(list, t, dur, ez) {
    var i = reached(list, t);
    if (i < 0) return 0;
    return i + (ez || ease.out2)(prog(t, list[i].t - E, dur || 0.08));
  }

  // The time to start a scene's own move (a card lands, a line is drawn) near t: the nearest kick or
  // snare within half a beat, else the nearest beat, shown E early. The move then lands on the music
  // without anything having to jump for it.
  function snap(t) {
    var best = null;
    hits.forEach(function (h) {
      if (h.k !== "kick" && h.k !== "snare" && h.k !== "rim") return;
      var d = Math.abs(h.t - t);
      if (d <= bar / 8 && (!best || d < Math.abs(best.t - t))) best = h;
    });
    return (best ? best.t : Math.round(t / (bar / 4)) * (bar / 4)) - E;
  }

  // A value made of moves [t0, from, to, dur, ease]: the latest move started by t decides it.
  function track(moves) {
    var list = moves.slice().sort(function (a, b) {
      return a[0] - b[0];
    });
    return function (t, rest) {
      var m = null;
      for (var i = 0; i < list.length && list[i][0] <= t; i++) m = list[i];
      if (!m) return rest;
      return m[1] + (m[2] - m[1]) * (m[4] || ease.out2)(prog(t, m[0], m[3]));
    };
  }

  // A hard shake that dies out: {x, y} in px, amp the first swing, over dur s from t0.
  var SX = [0, 1, -0.78, 0.56, -0.33, 0.17, 0],
    SY = [0, -0.67, 0.5, -0.33, 0.22, -0.11, 0];
  function shake(t, t0, amp, dur) {
    dur = dur || 0.55;
    if (t < t0 - E || t >= t0 - E + dur) return { x: 0, y: 0 };
    var x = ((t - t0 + E) / dur) * (SX.length - 1),
      i = Math.floor(x),
      f = x - i;
    return {
      x: amp * (SX[i] + (SX[i + 1] - SX[i]) * f),
      y: amp * (SY[i] + (SY[i + 1] - SY[i]) * f),
    };
  }

  // A white flash: `peak` at each time of `times`, gone after dur s. Keep it to the big moments.
  function flash(t, times, peak, dur) {
    var a = 0;
    dur = dur || 0.18;
    times.forEach(function (x) {
      var p = prog(t, x - E, dur);
      if (t >= x - E && p < 1) a = Math.max(a, (peak || 0.85) * (1 - ease.out2(p)));
    });
    return a;
  }

  function rgb(c) {
    var n = parseInt(c.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // A color between two #rrggbb colors.
  function mix(a, b, p) {
    var x = rgb(a),
      y = rgb(b);
    return (
      "rgb(" +
      [0, 1, 2]
        .map(function (i) {
          return Math.round(x[i] + (y[i] - x[i]) * p);
        })
        .join(",") +
      ")"
    );
  }

  function node(x) {
    var e = typeof x === "string" ? document.querySelector(x) : x;
    if (!e) throw new Error("no element " + x);
    return e;
  }
  // Opacity and visibility together, so a hidden element is not laid out as visible. Shown means
  // "inherit": an element inside a scene's section stays hidden while its section is.
  function alpha(x, a) {
    var e = node(x);
    e.style.opacity = String(a);
    e.style.visibility = a > 0.001 ? "inherit" : "hidden";
  }
  // Moves and scales an element in one write: o.x, o.y (px), o.s, o.sx, o.sy, o.r (deg), o.o (opacity).
  function place(x, o) {
    var e = node(x),
      s = o.s === undefined ? 1 : o.s;
    e.style.transform =
      "translate(" +
      (o.x || 0) +
      "px," +
      (o.y || 0) +
      "px) rotate(" +
      (o.r || 0) +
      "deg) scale(" +
      s * (o.sx === undefined ? 1 : o.sx) +
      "," +
      s * (o.sy === undefined ? 1 : o.sy) +
      ")";
    if (o.o !== undefined) alpha(e, o.o);
  }

  // How long a big word stays: two bars, at least 2 s and 1 s per 4 characters.
  function holdFor(text) {
    return Math.max(2 * bar, 2, text.replace(/\s/g, "").length / 4);
  }

  // Big words that land on hits and stay to be read. list: [{ el, t, soft, hold }]: el the word's
  // element (an underline <b> inside it wipes in), t the hit (or, with soft, the time it fades up).
  // A word that comes while the one before is still up sends that one, smaller, to the line above;
  // leave a line of room above the words for it. Returns a function for film.draw.
  function words(list) {
    var items = list.map(function (w) {
      var e = node(w.el);
      e.style.transformOrigin = "left bottom";
      var u = e.querySelector("b");
      if (u) u.style.transformOrigin = "left center";
      return {
        el: e,
        u: u,
        t0: w.soft ? w.t : w.t - E,
        soft: !!w.soft,
        hold: Math.max(w.hold || 0, holdFor(e.textContent)),
      };
    });
    items.forEach(function (it, i) {
      var n = items[i + 1];
      if (n && n.t0 < it.t0 + it.hold) {
        it.next = n;
        n.prev = it;
      }
    });
    function draw(it, t) {
      var end = it.t0 + it.hold;
      if (t < it.t0 || t >= end + 0.35) return alpha(it.el, 0);
      var dt = t - it.t0,
        a = 1,
        x = 0,
        y = 0,
        s = 1,
        wipe = 1;
      if (it.soft) {
        a = ease.out2(prog(dt, 0, 0.8));
        y = 30 * (1 - a);
      } else {
        var slam = it.prev ? 1.06 : 1.3; // under a word above, a small landing so the two never touch
        s = slam - (slam - 1) * back(2)(prog(dt, 0, 0.14));
        wipe = ease.expo(prog(dt, 0, 0.18));
        if (it.prev) x = -30 * (1 - wipe);
      }
      if (it.next) {
        var up = ease.out2(prog(t, it.next.t0 - 0.15, 0.15));
        y -= (1.06 * it.el.offsetHeight + 8) * up;
        s *= 1 - 0.6 * up;
      }
      if (t >= end) {
        var q = ease.in2(prog(t, end, 0.35));
        a *= 1 - q;
        y -= 12 * q;
      }
      alpha(it.el, a);
      it.el.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")";
      if (it.u) it.u.style.transform = "scaleX(" + wipe + ")";
    }
    return function (t) {
      items.forEach(function (it) {
        draw(it, t);
      });
    };
  }

  var sections = T.scenes
    .filter(function (s) {
      return s.section;
    })
    .map(function (s) {
      return { id: s.id, start: s.start, kind: s.section };
    });

  window.beat = {
    bpm: bpm,
    bar: bar,
    beat: bar / 4,
    E: E,
    hits: hits,
    sections: sections,
    // times of the scenes that start a drop, and of the final hit
    drops: sections
      .filter(function (s) {
        return s.kind === "drop";
      })
      .map(function (s) {
        return s.start;
      }),
    end: T.end === undefined ? null : T.end,
    // seconds of bar b plus `sixteenths` 16th notes
    at: function (b, sixteenths) {
      return b * bar + (sixteenths || 0) * (bar / 16);
    },
    ease: ease,
    prog: prog,
    pick: pick,
    pulse: pulse,
    since: since,
    steps: steps,
    snap: snap,
    track: track,
    shake: shake,
    flash: flash,
    mix: mix,
    alpha: alpha,
    place: place,
    hold: holdFor,
    words: words,
  };
})();
