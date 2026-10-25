// The player of an html film. Scene times come from kit/timing.js (written by "motion-render kit"
// from timing.json), so the page never hard-codes them. The page builds one paused GSAP timeline in
// film.build(); render.ts seeks it through window.__film.
(function () {
  var T = window.__timing;
  if (!T || !window.gsap)
    throw new Error("load kit/gsap.min.js and kit/timing.js before kit/player.js");
  var FAMILY = '"Noto Sans JP"';
  var scenes = {};
  T.scenes.forEach(function (s) {
    scenes[s.id] = s;
  });
  var timeline = gsap.timeline({ paused: true });
  var builders = [];

  function el(x) {
    var e = typeof x === "string" ? document.querySelector(x) : x;
    if (!e) throw new Error("no element " + x);
    return e;
  }
  // An element's laid-out box in frame px, ignoring transforms (GSAP's x/y/scale).
  function layoutBox(e) {
    var x = 0,
      y = 0;
    for (var p = e; p && p.id !== "root"; p = p.offsetParent) {
      x += p.offsetLeft;
      y += p.offsetTop;
    }
    return { x: x, y: y, w: e.offsetWidth, h: e.offsetHeight };
  }

  // Latin words and numbers stay whole so they do not break apart; everything else goes one
  // character at a time. Spaces become no-break spaces so an inline-block keeps their width.
  function glyphs(text) {
    return (text.match(/[A-Za-z0-9.,'’%+\-]+|\s+|[\s\S]/gu) || []).map(function (s) {
      return /^\s+$/.test(s) ? "\u00a0" : s;
    });
  }

  window.film = {
    scenes: scenes,
    total: T.total,
    timeline: timeline,
    // Seconds into the film of `dt` seconds into scene `id`.
    at: function (id, dt) {
      if (!scenes[id]) throw new Error('scene "' + id + '" is not in timing.json');
      return scenes[id].start + (dt || 0);
    },
    // `dt` seconds before scene `id` ends.
    end: function (id, dt) {
      return window.film.at(id, scenes[id] ? scenes[id].dur - (dt || 0) : 0);
    },
    // Runs fn(timeline) once the fonts are in, so text has its real size when the page measures it.
    build: function (fn) {
      builders.push(fn);
    },
    // GSAP x/y that put the center of `what` on the center of `target`, moved by (dx, dy).
    // Use it to send a chip to a card instead of working out pixel offsets by hand.
    spot: function (what, target, dx, dy) {
      var a = layoutBox(el(what)),
        b = layoutBox(el(target));
      return {
        x: b.x + b.w / 2 - (a.x + a.w / 2) + (dx || 0),
        y: b.y + b.h / 2 - (a.y + a.h / 2) + (dy || 0),
      };
    },
    // Sends `what` to `target` along an arc that rises `lift` px above the straight line, starting
    // `at` seconds into the film. o: { dur = 0.9, lift = 120, dx, dy }.
    arc: function (tl, what, target, at, o) {
      o = o || {};
      var dur = o.dur || 0.9,
        lift = o.lift === undefined ? 120 : o.lift,
        to = window.film.spot(what, target, o.dx, o.dy);
      tl.to(what, { x: to.x, duration: dur, ease: "power2.inOut" }, at);
      // The start y is read when the tween first renders, so earlier moves of `what` count.
      tl.to(
        what,
        {
          y: function (i, e) {
            return (Number(gsap.getProperty(e, "y")) + to.y) / 2 - lift;
          },
          duration: dur / 2,
          ease: "sine.out",
        },
        at
      );
      tl.to(what, { y: to.y, duration: dur / 2, ease: "sine.in" }, at + dur / 2);
      return tl;
    },
    // Keeps `what` gently scaling by `amount` (0.01 = 1%) from `at` until scene `id` ends, so a held
    // frame is never fully still. Do not tween the element's scale in the same span.
    breathe: function (tl, what, id, at, amount) {
      // An even number of halves, so the element is back at its own size when the scene ends.
      var half = 1.5,
        n = Math.floor((window.film.end(id) - at) / half / 2) * 2;
      if (n < 2) return tl;
      return tl.to(
        what,
        {
          scale: 1 + (amount || 0.01),
          duration: half,
          ease: "sine.inOut",
          repeat: n - 1,
          yoyo: true,
        },
        at
      );
    },
    // Raises the text of `what` one character at a time from below a mask line, starting `at`.
    // The text is split into spans the first time, so call it on an element that holds only text.
    // o: { dur = 0.5, stagger = 0.04 }.
    typeIn: function (tl, what, at, o) {
      o = o || {};
      var e = el(what);
      if (!e.querySelector(".type-mask")) {
        if (e.children.length)
          throw new Error("typeIn needs an element that holds only text: " + what);
        var mask = document.createElement("span");
        mask.className = "type-mask";
        glyphs(e.textContent.trim()).forEach(function (g) {
          var c = document.createElement("span");
          c.className = "type-char";
          c.textContent = g;
          mask.appendChild(c);
        });
        e.textContent = "";
        e.appendChild(mask);
      }
      // Hidden until its turn, so a character waiting below the mask line is not laid out as a
      // box sticking out of the line.
      return tl.fromTo(
        e.querySelectorAll(".type-char"),
        { yPercent: 110, autoAlpha: 0 },
        {
          yPercent: 0,
          autoAlpha: 1,
          duration: o.dur || 0.5,
          ease: "expo.out",
          stagger: o.stagger === undefined ? 0.04 : o.stagger,
        },
        at
      );
    },
  };

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll("section.scene"));
  }
  // A scene's section is shown over [start, start + dur); everything outside sections stays.
  function show(t) {
    sections().forEach(function (el) {
      var s = scenes[el.id];
      el.style.visibility = t >= s.start && t < s.start + s.dur ? "" : "hidden";
    });
  }
  // Fonts load per unicode-range subset on first use, so a scene's first frame could fall back.
  // Load every glyph the film shows before the first frame, and fail if any is missing.
  async function loadFonts() {
    var text = document.body.textContent.replace(/\s+/g, "") + "0123456789";
    var weights = ["400", "700"];
    try {
      await Promise.all(
        weights.map(function (w) {
          return document.fonts.load(w + " 48px " + FAMILY, text);
        })
      );
    } catch (e) {
      throw new Error(
        "font " + FAMILY + " failed to load (" + e.message + '). Run "motion-render kit" again.'
      );
    }
    await document.fonts.ready;
    weights.forEach(function (w) {
      if (!document.fonts.check(w + " 48px " + FAMILY, text))
        throw new Error(
          "font " + FAMILY + " " + w + ' did not load. Run "motion-render kit" again.'
        );
    });
  }

  window.__film = {
    load: async function () {
      var unknown = sections()
        .map(function (el) {
          return el.id;
        })
        .filter(function (id) {
          return !scenes[id];
        });
      if (unknown.length)
        throw new Error("section.scene ids not in timing.json: " + unknown.join(", "));
      await loadFonts();
      builders.forEach(function (fn) {
        fn(timeline);
      });
      window.__film.seek(0);
      return {
        duration: T.total,
        parts: T.scenes.map(function (s) {
          return { key: s.id, a0: s.start, dur: s.dur };
        }),
      };
    },
    seek: function (t) {
      show(t);
      // suppressEvents=false so onUpdate callbacks (count-ups) run on every seek.
      timeline.seek(t, false);
    },
  };
})();
