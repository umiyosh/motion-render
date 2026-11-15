// The player of an html film. Scene times come from kit/timing.js (written by "motion-render kit"
// from timing.json), so the page never hard-codes them. The page builds one paused GSAP timeline in
// film.build(); render.ts seeks it through window.__film.
(function () {
  var T = window.__timing;
  if (!T || !window.gsap)
    throw new Error("load kit/gsap.min.js and kit/timing.js before kit/player.js");
  // Each family with the weights kit/fonts.css has for it. Klee One is the hand-written face of the
  // paper, crayon and whiteboard styles, so it is loaded only when the page uses it.
  var FONTS = [
    { family: '"Noto Sans JP"', weights: ["400", "700"] },
    { family: '"Klee One"', weights: ["400", "600"], optional: true },
  ];
  // The filters kit/styles.css draws with. The noise of the line filters (.mr-boil) is re-seeded
  // 8 times a second so drawn lines shimmer like hand-drawn animation; the seed comes from the time,
  // so a frame always looks the same.
  var FILTERS =
    '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute">' +
    '<filter id="mr-pencil" x="-5%" y="-5%" width="110%" height="110%">' +
    '<feTurbulence class="mr-boil" type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="1" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
    '<feTurbulence type="fractalNoise" baseFrequency="1.2" numOctaves="1" seed="7" result="g"/>' +
    '<feColorMatrix in="g" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.5 1.5" result="tooth"/>' +
    '<feComposite in="d" in2="tooth" operator="in"/></filter>' +
    '<filter id="mr-crayon" x="-5%" y="-5%" width="110%" height="110%">' +
    '<feTurbulence class="mr-boil" type="fractalNoise" baseFrequency="0.03" numOctaves="2" seed="1" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" seed="5" result="g"/>' +
    '<feColorMatrix in="g" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -2 1.85" result="tooth"/>' +
    '<feComposite in="d" in2="tooth" operator="in"/></filter>' +
    '<filter id="mr-marker" x="-5%" y="-5%" width="110%" height="110%">' +
    '<feTurbulence class="mr-boil" type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="1" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G"/></filter>' +
    '<filter id="mr-torn" x="-5%" y="-5%" width="110%" height="110%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="4" seed="4" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/></filter>' +
    '<filter id="mr-tooth">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.75" numOctaves="2" seed="2" result="g"/>' +
    '<feColorMatrix in="g" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -3 2.1" result="tooth"/>' +
    '<feComposite in="SourceGraphic" in2="tooth" operator="in"/></filter>' +
    // Hatching for SVG shapes (fill="url(#mr-hatch)"): strokes in --line, and crossed strokes in --accent.
    '<pattern id="mr-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="7" style="stroke:var(--line);stroke-width:var(--hatch-w,2px)"/></pattern>' +
    '<pattern id="mr-hatch-accent" patternUnits="userSpaceOnUse" width="9" height="9" patternTransform="rotate(45)">' +
    '<line x1="0" y1="0" x2="0" y2="9" style="stroke:var(--accent);stroke-width:1.5px;opacity:.75"/>' +
    '<line x1="0" y1="0" x2="9" y2="0" style="stroke:var(--accent);stroke-width:1.5px;opacity:.5"/></pattern>' +
    "</svg>";
  var scenes = {};
  T.scenes.forEach(function (s) {
    scenes[s.id] = s;
  });
  var timeline = gsap.timeline({ paused: true });
  var builders = [];
  var draws = [];

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
  function htmlParent(e) {
    var p = e.parentNode;
    while (!(p instanceof HTMLElement)) p = p.parentNode;
    return p;
  }
  // How many times the transforms above `h` scale it on screen.
  function scaleOf(h) {
    return h.offsetWidth ? h.getBoundingClientRect().width / h.offsetWidth : 1;
  }
  // Frame px per unit of GSAP's x/y on `e`. Inside an <svg>, GSAP moves a shape in the svg's own
  // units, which a viewBox can make larger or smaller than px.
  function unit(e) {
    if (!(e instanceof SVGElement) || !e.ownerSVGElement) return 1;
    return e.parentNode.getScreenCTM().a / scaleOf(htmlParent(e));
  }
  // The center of `e` in frame px, leaving out its own GSAP x/y. SVG elements have no layout box,
  // so they are measured on screen against their nearest HTML parent.
  function center(e) {
    if (e instanceof HTMLElement) {
      var b = layoutBox(e);
      return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    }
    var h = htmlParent(e),
      hb = layoutBox(h),
      s = scaleOf(h),
      u = unit(e),
      r = e.getBoundingClientRect(),
      hr = h.getBoundingClientRect();
    return {
      x: hb.x + (r.x + r.width / 2 - hr.x) / s - Number(gsap.getProperty(e, "x")) * u,
      y: hb.y + (r.y + r.height / 2 - hr.y) / s - Number(gsap.getProperty(e, "y")) * u,
    };
  }

  // Latin words and numbers stay whole so they do not break apart; everything else goes one
  // character at a time. Spaces become no-break spaces so an inline-block keeps their width.
  function glyphs(text) {
    return (text.match(/[A-Za-z0-9.,'’%+\-]+|\s+|[\s\S]/gu) || []).map(function (s) {
      return /^\s+$/.test(s) ? "\u00a0" : s;
    });
  }

  // The text of `what` as one span per glyph inside a mask (made once), for film.typeIn and
  // film.say. `who` names the caller in the error for an element that holds more than text.
  function charSpans(what, who) {
    var e = el(what);
    if (!e.querySelector(".type-mask")) {
      if (e.children.length)
        throw new Error(who + " needs an element that holds only text: " + what);
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
    return Array.prototype.slice.call(e.querySelectorAll(".type-char"));
  }

  // Characters that are not voiced: spaces and punctuation.
  var QUIET = /[\s、。，．,.!?！？「」『』（）()・…:：;；"'“”‘’]/;

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
    // Seconds into scene `id` at which its narration starts saying each character of its text (by
    // code point). The times are measured on the scene's audio (scripts/words.ts); before there is
    // any audio, the voiced characters are spread over the narration's length.
    times: function (id) {
      var W = window.__words && window.__words[id];
      if (!scenes[id]) throw new Error('scene "' + id + '" is not in timing.json');
      if (!W) throw new Error('film.word: no narration for "' + id + '" in kit/timing.js');
      if (W.at) return W.at.slice();
      var chars = Array.from(W.text),
        voiced = chars.filter(function (c) {
          return !QUIET.test(c);
        }).length,
        k = 0;
      return chars.map(function (c) {
        var t = W.lead + (W.speech * k) / Math.max(1, voiced);
        if (!QUIET.test(c)) k++;
        return t;
      });
    },
    // Seconds into scene `id` at which its narration starts saying `w` (its n-th time, from 1), from
    // film.times. A word the narration does not say is an error, so check stops on it.
    word: function (id, w, n) {
      n = n || 1;
      var times = window.film.times(id),
        W = window.__words[id];
      if (!w) throw new Error("film.word needs a word");
      var i = -1;
      for (var k = 0; k < n; k++) {
        i = W.text.indexOf(w, i + 1);
        if (i < 0)
          throw new Error(
            'film.word: the narration of "' +
              id +
              '" does not say "' +
              w +
              '"' +
              (n > 1 ? " " + n + " times" : "")
          );
      }
      return times[Array.from(W.text.slice(0, i)).length];
    },
    // The text of `what` split into one span per glyph (.type-char, inside a .type-mask), once; the
    // spans are returned. kit/type.js and film.typeIn animate these.
    chars: function (what) {
      return charSpans(what, "film.chars");
    },
    // Runs fn(timeline) once the fonts are in, so text has its real size when the page measures it.
    build: function (fn) {
      builders.push(fn);
    },
    // Calls fn(t) on every frame, after the timeline, with the time in seconds. fn sets every value
    // it owns from t alone, so a frame is the same however the film got there (beat-synced motion:
    // kit/beat.js). GSAP tweens remember their start values and can differ after seeking back.
    draw: function (fn) {
      draws.push(fn);
    },
    // The time of the MP4 frame being drawn (fn's second argument too): equal to t except under motion
    // blur. Read changing text from it.
    frameTime: 0,
    // GSAP x/y that put the center of `what` on the center of `target`, moved by (dx, dy).
    // Use it to send a chip to a card instead of working out pixel offsets by hand. Either may be an
    // SVG element, such as an <svg> icon or a shape inside a diagram.
    spot: function (what, target, dx, dy) {
      var w = el(what),
        a = center(w),
        b = center(el(target)),
        u = unit(w);
      return {
        x: (b.x - a.x + (dx || 0)) / u,
        y: (b.y - a.y + (dy || 0)) / u,
      };
    },
    // Sends `what` to `target` along an arc that rises `lift` px above the straight line, starting
    // `at` seconds into the film. o: { dur = 0.9, lift = 120, dx, dy }.
    arc: function (tl, what, target, at, o) {
      o = o || {};
      var dur = o.dur || 0.9,
        lift = (o.lift === undefined ? 120 : o.lift) / unit(el(what)),
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
    // Lights a .step or .card of kit/parts.css at `at` (its --on goes to 1), and puts it out again
    // at o.off when given. o: { dur = 0.35, off }.
    light: function (tl, what, at, o) {
      o = o || {};
      var dur = o.dur || 0.35;
      tl.to(what, { "--on": 1, duration: dur, ease: "power2.out" }, at);
      if (o.off !== undefined) tl.to(what, { "--on": 0, duration: dur, ease: "power2.in" }, o.off);
      return tl;
    },
    // Fills a .ruler of kit/parts.css with a tick every o.step from its --from to its --to, each
    // labeled with o.label ("{v} 秒"; "" for no labels). Call it inside film.build.
    ticks: function (what, o) {
      var e = el(what),
        css = getComputedStyle(e),
        from = Number(css.getPropertyValue("--from")),
        to = Number(css.getPropertyValue("--to")),
        step = o && o.step,
        label = o && o.label !== undefined ? o.label : "{v}";
      if (!(step > 0) || !(to > from)) throw new Error("film.ticks needs --from < --to and a step");
      for (var i = 0; from + i * step <= to + 1e-9; i++) {
        var v = Math.round((from + i * step) * 1000) / 1000,
          t = document.createElement("i");
        t.className = "tick";
        t.style.setProperty("--at", String(v));
        if (label) t.textContent = label.replace("{v}", String(v));
        e.appendChild(t);
      }
      return e;
    },
    // Shows a caption from `at` and takes it away so it is gone 0.25 s before scene `id` ends, as
    // references/html-film.md asks.
    caption: function (tl, what, id, at) {
      tl.fromTo(
        what,
        { autoAlpha: 0, y: 16 },
        { autoAlpha: 1, y: 0, duration: 0.4, ease: "expo.out" },
        at
      );
      return tl.to(
        what,
        { autoAlpha: 0, duration: 0.2, ease: "power3.in" },
        window.film.end(id, 0.45)
      );
    },
    // Raises the text of `what` one character at a time from below a mask line, starting `at`.
    // The text is split into spans the first time, so call it on an element that holds only text.
    // o: { dur = 0.5, stagger = 0.04 }.
    typeIn: function (tl, what, at, o) {
      o = o || {};
      // Hidden until its turn, so a character waiting below the mask line is not laid out as a
      // box sticking out of the line.
      return tl.fromTo(
        charSpans(what, "typeIn"),
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
    // A scene change through a shape: the next scene shows inside `shape`, an SVG shape of the scene
    // before it (a circle, a rounded rect, the outline of a thing), and the shape grows until it fills
    // the frame on the first frame of scene `next`, so the change lands on its beat. It starts o.dur s
    // before, from the shape's own size and place; until scene `next` starts, what shows inside is that
    // scene before its own entrances (its ground). The shape grows by equal ratios in equal times (as
    // fx.zoom: the eye reads a change of size as a ratio), about its centre or o.at ({ x, y } in px of
    // the frame). o: { dur = 0.6, ease = "power2.in" }. Call it inside film.build.
    wipe: function (shape, next, o) {
      o = o || {};
      var s = el(shape);
      if (!(s instanceof SVGGraphicsElement))
        throw new Error("film.wipe: the shape must be an SVG shape");
      if (!scenes[next]) throw new Error('film.wipe: scene "' + next + '" is not in timing.json');
      var section = document.getElementById(next);
      if (!section || !section.classList.contains("scene"))
        throw new Error('film.wipe: no section.scene with id "' + next + '"');
      var dur = o.dur || 0.6,
        t1 = scenes[next].start;
      if (dur > t1)
        throw new Error("film.wipe: " + dur + " s is longer than the film before " + next);
      var clip = document.createElementNS(SVG, "clipPath"),
        copy = s.cloneNode(true);
      clip.id = "mr-wipe-" + wipes.length;
      clip.setAttribute("clipPathUnits", "userSpaceOnUse");
      copy.removeAttribute("id");
      clip.appendChild(copy);
      wipeDefs().appendChild(clip);
      wipes.push({
        shape: s,
        section: section,
        clip: clip,
        copy: copy,
        t0: t1 - dur,
        t1: t1,
        ease: gsap.parseEase(o.ease || "power2.in"),
        at: o.at,
      });
    },
  };

  // The <defs> that holds the clip paths of film.wipe.
  var SVG = "http://www.w3.org/2000/svg",
    wipes = [],
    defs = null;
  function wipeDefs() {
    if (defs) return defs;
    var svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    defs = document.createElementNS(SVG, "defs");
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }
  function wiping(w, t) {
    return t >= w.t0 && t < w.t1;
  }
  // Each wipe at time t: the next scene clipped to the shape, grown from where the shape is now. Both
  // scenes are marked while it runs, so the layout check does not take the next scene's things,
  // clipped away, for things on top of the scene before.
  function drawWipes(t) {
    wipes.forEach(function (w) {
      var on = wiping(w, t),
        before = document.getElementById(scenePlaying(w.t0));
      [w.section, before].forEach(function (e) {
        if (e) e.toggleAttribute("data-wiping", on);
      });
      if (!on) {
        w.section.style.clipPath = "";
        w.section.style.zIndex = "";
        return;
      }
      var box = w.shape.getBoundingClientRect(),
        frame = w.section.getBoundingClientRect(),
        m = w.shape.getScreenCTM(),
        c = w.at || { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      var far = Math.max(
        Math.hypot(c.x - frame.left, c.y - frame.top),
        Math.hypot(frame.right - c.x, c.y - frame.top),
        Math.hypot(c.x - frame.left, frame.bottom - c.y),
        Math.hypot(frame.right - c.x, frame.bottom - c.y)
      );
      var r = Math.max(1, Math.min(box.width, box.height) / 2),
        full = (1.15 * far) / r,
        s = Math.pow(full, w.ease((t - w.t0) / (w.t1 - w.t0)));
      w.copy.setAttribute(
        "transform",
        "translate(" +
          (c.x - frame.left) +
          "," +
          (c.y - frame.top) +
          ") scale(" +
          s +
          ") " +
          "translate(" +
          -c.x +
          "," +
          -c.y +
          ") matrix(" +
          [m.a, m.b, m.c, m.d, m.e, m.f].join(",") +
          ")"
      );
      w.section.style.clipPath = "url(#" + w.clip.id + ")";
      // Sections share the layers' z-index (base.css), so a card of the scene before would be drawn
      // over the next scene's ground. The clip makes the next scene one group: it goes over all of
      // the scene before but its captions (layer-caption, 50).
      w.section.style.zIndex = "49";
    });
  }
  // The id of the scene showing at t.
  function scenePlaying(t) {
    var id = null;
    T.scenes.forEach(function (s) {
      if (t >= s.start && t < s.start + s.dur) id = s.id;
    });
    return id;
  }

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll("section.scene"));
  }
  function repeatedIds() {
    var seen = {},
      twice = [];
    document.querySelectorAll("[id]").forEach(function (e) {
      if (!e.id) return;
      if (seen[e.id] && twice.indexOf(e.id) < 0) twice.push(e.id);
      seen[e.id] = true;
    });
    return twice;
  }
  // A scene's section is shown over [start, start + dur), and while a wipe into it runs; everything
  // outside sections stays.
  function show(t) {
    sections().forEach(function (el) {
      var s = scenes[el.id],
        wiped = wipes.some(function (w) {
          return w.section === el && wiping(w, t);
        });
      el.style.visibility = wiped || (t >= s.start && t < s.start + s.dur) ? "" : "hidden";
    });
  }
  // Fonts load per unicode-range subset on first use, so a scene's first frame could fall back.
  // Load every glyph the film shows before the first frame, and fail if any is missing.
  function usesFamily(family) {
    var name = family.replace(/"/g, "");
    return Array.prototype.some.call(document.querySelectorAll("body, body *"), function (e) {
      return getComputedStyle(e).fontFamily.indexOf(name) >= 0;
    });
  }
  async function loadFonts() {
    var text = document.body.textContent.replace(/\s+/g, "") + "0123456789";
    var faces = [];
    FONTS.forEach(function (f) {
      if (f.optional && !usesFamily(f.family)) return;
      f.weights.forEach(function (w) {
        faces.push({ family: f.family, spec: w + " 48px " + f.family });
      });
    });
    try {
      await Promise.all(
        faces.map(function (f) {
          return document.fonts.load(f.spec, text);
        })
      );
    } catch (e) {
      throw new Error(
        "font " +
          faces
            .map(function (f) {
              return f.spec;
            })
            .join(", ") +
          " failed to load (" +
          e.message +
          '). Run "motion-render kit" again.'
      );
    }
    await document.fonts.ready;
    faces.forEach(function (f) {
      if (!document.fonts.check(f.spec, text))
        throw new Error("font " + f.spec + ' did not load. Run "motion-render kit" again.');
    });
  }
  function addFilters() {
    var holder = document.createElement("div");
    holder.innerHTML = FILTERS;
    document.body.appendChild(holder.firstChild);
  }
  function boil(t) {
    var seed = String(1 + (Math.floor(t * 8) % 4));
    document.querySelectorAll(".mr-boil").forEach(function (n) {
      n.setAttribute("seed", seed);
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
      var twice = repeatedIds();
      if (twice.length)
        throw new Error(
          "ids used more than once: " +
            twice.join(", ") +
            ". A selector #id reaches all of them, so hiding or moving one also hides or moves the others"
        );
      addFilters();
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
    // `frame` is the time of the MP4 frame this picture goes into. With motion blur, several pictures
    // at times around it are averaged into one frame, and text that changes (a count-up) must take
    // its value from the frame's time, or the digits of the pictures blur into each other.
    seek: function (t, frame) {
      var f = frame === undefined ? t : frame;
      window.film.frameTime = f;
      show(t);
      boil(t);
      // suppressEvents=false so onUpdate callbacks (count-ups) run on every seek. GSAP renders
      // nothing when the playhead is already at t, and a new timeline sits at 0 s: without the forced
      // render, what the film sets at 0 s is missing from the first frame of a fresh page.
      if (timeline.totalTime() === t) timeline.render(t, false, true);
      else timeline.seek(t, false);
      draws.forEach(function (fn) {
        fn(t, f);
      });
      // After the timeline and the draws, so the shape is where this frame puts it.
      drawWipes(t);
    },
  };
})();
