// Kinetic typography for html films, timed by the narration: text that comes in (film.say), is marked
// (film.mark), is replaced (film.swap) or counts up (film.count) at the moment the narration says a
// word, and a line that lights up with the voice (film.karaoke). Load after kit/player.js.
//
// Every effect is drawn from the time alone (seeking back and forth draws the same frame) and comes
// to rest: text that is read holds still. Glyphs that run through stand-ins, scatter offsets and
// orders come from an integer hash, never from Math.random. The effects follow common motion-design
// practice (After Effects text animators, lyric video and Japanese telop conventions); see
// references/html-film.md "文字を動かす" for when to use which.
(function () {
  var film = window.film;
  if (!film || !film.word) throw new Error("load kit/player.js before kit/type.js");
  var EARLY = 0.008; // a picture slightly early reads as on time (kit/beat.js)

  // A whole number from (i, k) that looks random and is always the same (an integer hash).
  function mix(i, k) {
    var h = Math.imul(i + 1, 374761393) ^ Math.imul(k + 7, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }
  var unit = function (i, k) {
    return mix(i, k) / 4294967296; // in [0, 1)
  };
  var KANA =
    "アカサタナハマヤラワイキシチニヒミリウクスツヌフムユルエケセテネヘメレオコソトノホモヨロ";
  var LATIN = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

  // A stand-in for glyph `g` at step k: as many characters, of the same kind (kana for Japanese,
  // letters and digits for Latin). A space stays.
  function standIn(g, i, k) {
    if (!g.trim()) return g;
    var pool = /^[\x21-\x7e’]+$/.test(g) ? LATIN : KANA;
    return Array.from(g)
      .map(function (_, j) {
        return pool[mix(i * 31 + j, k) % pool.length];
      })
      .join("");
  }

  function el(what) {
    var e = typeof what === "string" ? document.querySelector(what) : what;
    if (!e) throw new Error("no element " + what);
    return e;
  }

  // The film time at which the narration of scene `id` starts saying `w`, shown o.lead early.
  function when(id, w, o) {
    var lead = o.lead === undefined ? EARLY : o.lead;
    return Math.max(0, film.at(id, film.word(id, w, o.n)) - lead);
  }

  // The order the characters start in (o.from): "start" (left first), "end", "center" (from the
  // middle out), "edges" (from both ends in) or "random" (a fixed shuffle), as a delay per index.
  function delays(n, o, each) {
    var from = o.from || "start",
      mid = (n - 1) / 2;
    var rank = function (i) {
      if (from === "start") return i;
      if (from === "end") return n - 1 - i;
      if (from === "center") return Math.abs(i - mid);
      if (from === "edges") return mid - Math.abs(i - mid);
      if (from === "random") return order[i];
      throw new Error('o.from must be "start", "end", "center", "edges" or "random", not ' + from);
    };
    var order = [];
    if (from === "random") {
      var idx = Array.from({ length: n }, function (_, i) {
        return i;
      }).sort(function (a, b) {
        return mix(a, 911) - mix(b, 911);
      });
      idx.forEach(function (i, r) {
        order[i] = r;
      });
    }
    return function (i) {
      return rank(i) * each;
    };
  }

  var opt = function (v, d) {
    return v === undefined ? d : v;
  };

  // The box that holds the glyphs of `e` (film.chars), as wide as the text itself: decorations
  // hug the text inside it even when `e` spans the frame.
  function textBox(e) {
    return film.chars(e)[0].parentNode;
  }

  // A .kt-* decoration drawn over the text of `e`: a created span inside its text box, which becomes
  // its positioning box and no longer clips. data-layout-ok tells the layout check that the overlap
  // with the text is meant.
  function decoration(e, cls) {
    var box = textBox(e);
    box.style.position = "relative";
    box.style.overflow = "visible";
    box.style.isolation = "isolate"; // marks drawn behind the text stay above the page
    var d = document.createElement("span");
    d.className = cls;
    d.setAttribute("data-layout-ok", "");
    box.appendChild(d);
    return d;
  }

  // Runs fn(t) on every render of [at, at + dur] with the seconds since `at` (0 before, dur after):
  // drawing from the time alone, so seeking back draws the same frame.
  function over(tl, at, dur, fn) {
    var run = { t: 0 };
    return tl.fromTo(
      run,
      { t: 0 },
      {
        t: dur,
        duration: dur,
        ease: "none",
        onUpdate: function () {
          fn(run.t);
        },
      },
      at
    );
  }

  // An inset() clip that cuts `amount` (0 to 1) of the box away from one side: 0 top, 1 right,
  // 2 bottom, 3 left. Every value carries its unit, so no tween has to guess one.
  function inset(side, amount) {
    var v = ["0%", "0%", "0%", "0%"];
    v[side] = amount * 100 + "%";
    return "inset(" + v.join(" ") + ")";
  }

  // Sets the clip-path of `target` to at(p) for the eased progress p of [at, at + dur], computed
  // from the time on every render (and at(0) until then), so a frame mid-wipe is the same after
  // seeking back: a tween between clip-path strings is not (#60).
  function clip(tl, target, at, dur, value) {
    var ease = gsap.parseEase("power2.inOut");
    target.style.clipPath = value(0);
    return over(tl, at, dur, function (t) {
      target.style.clipPath = value(ease(Math.min(1, t / dur)));
    });
  }

  // ---- entrances: film.say(tl, what, id, word, { how }) ----

  // Each returns the timeline. `c` is the list of glyph spans, `e` the element, `o` the options.
  var ENTER = {
    // Characters rise from below the line, clipped by it.
    rise: function (tl, c, e, at, o) {
      return tl.fromTo(
        c,
        { yPercent: 110, autoAlpha: 0 },
        {
          yPercent: 0,
          autoAlpha: 1,
          duration: opt(o.dur, 0.5),
          ease: "expo.out",
          stagger: delays(c.length, o, opt(o.stagger, 0.04)),
        },
        at
      );
    },
    // Characters fade in while drifting up a little, with no mask.
    fade: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      return tl.fromTo(
        c,
        { yPercent: 35, autoAlpha: 0 },
        {
          yPercent: 0,
          autoAlpha: 1,
          duration: opt(o.dur, 0.55),
          ease: "power2.out",
          stagger: delays(c.length, o, opt(o.stagger, 0.035)),
        },
        at
      );
    },
    // Characters come into focus from a blur.
    blur: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      return tl.fromTo(
        c,
        { autoAlpha: 0, filter: "blur(14px)", scale: 1.08 },
        {
          autoAlpha: 1,
          filter: "blur(0px)",
          scale: 1,
          duration: opt(o.dur, 0.6),
          ease: "power2.out",
          stagger: delays(c.length, o, opt(o.stagger, 0.03)),
        },
        at
      );
    },
    // Characters start spread apart and close in to their places (tracking in). Each one moves by
    // a transform, so the line's width and its neighbors stay put.
    track: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      var mid = (c.length - 1) / 2,
        spread = opt(o.spread, 0.45);
      return tl.fromTo(
        c,
        {
          autoAlpha: 0,
          x: function (i, t) {
            return (i - mid) * spread * parseFloat(getComputedStyle(t).fontSize);
          },
        },
        { autoAlpha: 1, x: 0, duration: opt(o.dur, 0.8), ease: "power3.out" },
        at
      );
    },
    // Characters pop from nothing to full size with a small overshoot.
    pop: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      return tl.fromTo(
        c,
        { autoAlpha: 0, scale: 0.2 },
        {
          autoAlpha: 1,
          scale: 1,
          duration: opt(o.dur, 0.4),
          ease: "back.out(1.4)",
          stagger: delays(c.length, o, opt(o.stagger, 0.04)),
        },
        at
      );
    },
    // The whole word slams down from large and stops dead: for the one key word.
    slam: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      tl.set(c, { autoAlpha: 0 }, 0);
      tl.set(c, { autoAlpha: 1 }, at);
      return tl.fromTo(
        e.querySelector(".type-mask"),
        { scale: opt(o.from, 2.6) },
        { scale: 1, duration: opt(o.dur, 0.22), ease: "power3.in" },
        at
      );
    },
    // Characters hinge in on their baseline like cards turning over.
    flip: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      return tl.fromTo(
        c,
        { autoAlpha: 0, rotationX: -95, transformPerspective: 600, transformOrigin: "50% 100%" },
        {
          autoAlpha: 1,
          rotationX: 0,
          duration: opt(o.dur, 0.6),
          ease: "power3.out",
          stagger: delays(c.length, o, opt(o.stagger, 0.05)),
        },
        at
      );
    },
    // An edge sweeps across and uncovers the text (o.dir: "right", "left", "down", "up").
    wipe: function (tl, c, e, at, o) {
      var dir = o.dir || "right";
      var side = { right: 1, left: 3, down: 2, up: 0 }[dir];
      if (side === undefined)
        throw new Error('o.dir must be "right", "left", "down" or "up", not ' + dir);
      // hidden outright until the wipe starts, so nothing reads the clipped text as shown
      tl.set(c, { autoAlpha: 0 }, 0);
      tl.set(c, { autoAlpha: 1 }, at);
      return clip(tl, e.querySelector(".type-mask"), at, opt(o.dur, 0.5), function (p) {
        return inset(side, 1 - p);
      });
    },
    // A solid bar grows across the text, then pulls away to the other side and leaves the text
    // behind (a box reveal). Its colour is --kt-box, else the accent.
    box: function (tl, c, e, at, o) {
      var bar = decoration(e, "kt-box"),
        half = opt(o.dur, 0.6) / 2;
      tl.set(c, { autoAlpha: 0 }, 0);
      tl.fromTo(
        bar,
        { scaleX: 0, transformOrigin: "0% 50%" },
        { scaleX: 1, duration: half, ease: "power3.out" },
        at
      );
      tl.set(c, { autoAlpha: 1 }, at + half);
      tl.set(bar, { transformOrigin: "100% 50%" }, at + half);
      return tl.to(bar, { scaleX: 0, duration: half, ease: "power3.in" }, at + half);
    },
    // Characters fly in from scattered places and turns and lock into the word (fixed offsets).
    assemble: function (tl, c, e, at, o) {
      e.querySelector(".type-mask").style.overflow = "visible";
      var far = opt(o.spread, 2.2);
      return tl.fromTo(
        c,
        {
          autoAlpha: 0,
          x: function (i, t) {
            return (unit(i, 1) - 0.5) * 2 * far * parseFloat(getComputedStyle(t).fontSize);
          },
          y: function (i, t) {
            return (unit(i, 2) - 0.5) * 2 * far * parseFloat(getComputedStyle(t).fontSize);
          },
          rotation: function (i) {
            return (unit(i, 3) - 0.5) * 140;
          },
        },
        {
          autoAlpha: 1,
          x: 0,
          y: 0,
          rotation: 0,
          duration: opt(o.dur, 0.8),
          ease: "power3.out",
          stagger: delays(c.length, o, opt(o.stagger, 0.02)),
        },
        at
      );
    },
    // Characters appear one after another in place; o.cursor adds a caret that follows the typing
    // and blinks for o.hold seconds (0.8) after the last character, then goes.
    write: function (tl, c, e, at, o) {
      var delay = delays(c.length, o, opt(o.stagger, 0.05));
      tl.fromTo(
        c,
        { autoAlpha: 0 },
        { autoAlpha: 1, duration: 0.001, ease: "none", stagger: delay },
        at
      );
      if (!o.cursor) return tl;
      var typed = c.reduce(function (a, _, i) {
          return Math.max(a, delay(i));
        }, 0),
        hold = opt(o.hold, 0.8);
      return over(tl, at, typed + hold, function (t) {
        // the caret sits after the character that appeared last by t
        var k = 0;
        c.forEach(function (_, i) {
          if (delay(i) <= t + 1e-6 && delay(i) >= delay(k)) k = i;
        });
        var on =
          t > 0 && (t <= typed || Math.floor((t - typed) * 2.5) % 2 === 0) && t < typed + hold;
        c.forEach(function (s, i) {
          if (on && i === k) s.setAttribute("data-caret", "");
          else s.removeAttribute("data-caret");
        });
      });
    },
    // Every character runs through stand-ins of its kind; they settle in the order of o.from. The
    // span keeps its final glyph (and so its width): the stand-in is drawn over it (kit/base.css).
    scramble: function (tl, c, e, at, o) {
      var finals = c.map(function (s) {
        return s.textContent;
      });
      var dur = opt(o.dur, 0.45),
        settle = delays(c.length, o, opt(o.stagger, 0.05)),
        total =
          dur +
          c.reduce(function (a, _, i) {
            return Math.max(a, settle(i));
          }, 0);
      tl.fromTo(c, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.001, ease: "none" }, at);
      // 24 changes a second, from the time alone
      return over(tl, at, total, function (t) {
        var k = Math.floor(t * 24);
        c.forEach(function (s, i) {
          if (t <= 0 || t >= dur + settle(i)) s.removeAttribute("data-stand-in");
          else s.setAttribute("data-stand-in", standIn(finals[i], i, k));
        });
      });
    },
  };

  // ---- marks on text already on screen: film.mark(tl, what, id, word, { how }) ----

  var MARK = {
    // A translucent marker band draws behind the text, left to right (--kt-mark).
    highlight: function (tl, e, at, o) {
      var d = decoration(e, "kt-highlight");
      return tl.fromTo(
        d,
        { scaleX: 0 },
        { scaleX: 1, duration: opt(o.dur, 0.4), ease: "power2.out" },
        at
      );
    },
    // A rule draws under the text.
    underline: function (tl, e, at, o) {
      var d = decoration(e, "kt-underline");
      return tl.fromTo(
        d,
        { scaleX: 0 },
        { scaleX: 1, duration: opt(o.dur, 0.35), ease: "power2.out" },
        at
      );
    },
    // A rule draws through the text: "not this".
    strike: function (tl, e, at, o) {
      var d = decoration(e, "kt-strike");
      return tl.fromTo(
        d,
        { scaleX: 0 },
        { scaleX: 1, duration: opt(o.dur, 0.3), ease: "power2.inOut" },
        at
      );
    },
    // A hand-drawn ellipse is drawn around the text.
    circle: function (tl, e, at, o) {
      var d = decoration(e, "kt-circle");
      d.innerHTML =
        '<svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M52 4 C80 3 98 22 97 50 C96 79 74 97 48 96 C21 95 3 76 4 49 C5 22 26 6 58 7"/></svg>';
      var path = d.querySelector("path"),
        ease = gsap.parseEase("power2.inOut"),
        dur = opt(o.dur, 0.5);
      path.style.visibility = "hidden";
      // The stroke keeps its width on a stretched box (non-scaling-stroke), so its dashes are in
      // screen px: the loop's length is taken from the box (an ellipse's perimeter, Ramanujan's
      // approximation, with room for the overlapping tail), from the layout alone.
      return over(tl, at, dur, function (t) {
        var a = d.offsetWidth * 0.47,
          b = d.offsetHeight * 0.47,
          len = 1.15 * Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
        var p = ease(Math.min(1, t / dur));
        path.style.visibility = p > 0 && len > 0 ? "visible" : "hidden";
        path.style.strokeDasharray = len + " " + len;
        path.style.strokeDashoffset = String(len * (1 - p));
      });
    },
    // The text turns to the accent colour (o.color).
    color: function (tl, e, at, o) {
      var to =
        o.color ||
        getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() ||
        "#3ed6c4";
      return tl.to(e, { color: to, duration: opt(o.dur, 0.25), ease: "power1.out" }, at);
    },
    // The text swells a little and settles back once.
    bump: function (tl, e, at, o) {
      var up = opt(o.dur, 0.36) / 3;
      var box = textBox(e);
      tl.to(box, { scale: opt(o.scale, 1.12), duration: up, ease: "power2.out" }, at);
      return tl.to(box, { scale: 1, duration: up * 2, ease: "power2.inOut" }, at + up);
    },
  };

  // ---- swaps: film.swap(tl, what, id, word, newText, { how }) ----

  // Puts the old and the new text in one grid cell of `e`, so the line is as wide as the wider.
  function slot(e, text) {
    var old = e.textContent;
    e.textContent = "";
    var s = document.createElement("span");
    s.className = "kt-slot";
    var a = document.createElement("span"),
      b = document.createElement("span");
    a.textContent = old;
    b.textContent = text;
    s.appendChild(a);
    s.appendChild(b);
    e.appendChild(s);
    return { s: s, a: a, b: b };
  }

  var SWAP = {
    // Hard cut: the new text replaces the old on the frame.
    cut: function (tl, x, at) {
      tl.set(x.b, { autoAlpha: 0 }, 0);
      tl.set(x.a, { autoAlpha: 0 }, at);
      return tl.set(x.b, { autoAlpha: 1 }, at);
    },
    // The old text rolls up out of the slot and the new rolls up into it.
    roll: function (tl, x, at, o) {
      x.s.style.overflow = "hidden";
      var d = opt(o.dur, 0.5);
      tl.fromTo(x.a, { yPercent: 0 }, { yPercent: -110, duration: d, ease: "power3.inOut" }, at);
      return tl.fromTo(
        x.b,
        { yPercent: 110 },
        { yPercent: 0, duration: d, ease: "power3.inOut" },
        at
      );
    },
    // An edge sweeps across: behind it the new text, ahead of it the old.
    wipe: function (tl, x, at, o) {
      var d = opt(o.dur, 0.45);
      // each side is also hidden outright outside its part of the wipe
      tl.set(x.b, { autoAlpha: 0 }, 0);
      tl.set(x.b, { autoAlpha: 1 }, at);
      tl.set(x.a, { autoAlpha: 0 }, at + d);
      clip(tl, x.a, at, d, function (p) {
        return inset(3, p); // the old text is cut away from its left
      });
      return clip(tl, x.b, at, d, function (p) {
        return inset(1, 1 - p); // the new text is uncovered towards its right
      });
    },
    // The old text blurs out, then the new one comes into focus, without overlapping.
    blur: function (tl, x, at, o) {
      var d = opt(o.dur, 0.3) / 2;
      tl.fromTo(
        x.a,
        { autoAlpha: 1, filter: "blur(0px)" },
        { autoAlpha: 0, filter: "blur(10px)", duration: d, ease: "power1.in" },
        at
      );
      return tl.fromTo(
        x.b,
        { autoAlpha: 0, filter: "blur(10px)" },
        { autoAlpha: 1, filter: "blur(0px)", duration: d, ease: "power1.out" },
        at + d
      );
    },
  };

  function oneOf(table, how, what) {
    var fn = table[how];
    if (!fn)
      throw new Error(
        what + ': o.how must be one of "' + Object.keys(table).join('", "') + '", not ' + how
      );
    return fn;
  }

  // The digits of a number as the element writes them: as many decimal places, and thousands
  // separators only if it has them (12,345 / 1.5 / 2026).
  function formatter(o, sample, grouped) {
    if (o.format) return o.format;
    var places = (String(sample).split(".")[1] || "").length;
    return function (v) {
      return v.toLocaleString("en-US", {
        minimumFractionDigits: places,
        maximumFractionDigits: places,
        useGrouping: grouped,
      });
    };
  }

  Object.assign(film, {
    // Brings in the text of `what` as the narration of scene `id` starts saying `word`; the text is
    // hidden until then. o.how: rise (default), fade, blur, track, pop, slam, flip, wipe, box,
    // assemble, write, scramble. o.from: the order the characters start in. o.n, o.lead, o.dur,
    // o.stagger, and per way: o.dir (wipe), o.spread (track, assemble), o.cursor and o.hold (write).
    say: function (tl, what, id, word, o) {
      o = o || {};
      var fn = oneOf(ENTER, o.how || "rise", "film.say");
      var e = el(what),
        c = film.chars(e);
      return fn(tl, c, e, when(id, word, o), o);
    },
    // Marks `what`, already on screen, as the narration says `word`. o.how: highlight (default),
    // underline, strike, circle, color, bump. The mark stays.
    mark: function (tl, what, id, word, o) {
      o = o || {};
      return oneOf(MARK, o.how || "highlight", "film.mark")(tl, el(what), when(id, word, o), o);
    },
    // Replaces the text of `what` with `text` as the narration says `word`. o.how: roll (default),
    // wipe, blur, cut.
    swap: function (tl, what, id, word, text, o) {
      o = o || {};
      var fn = oneOf(SWAP, o.how || "roll", "film.swap");
      return fn(tl, slot(el(what), text), when(id, word, o), o);
    },
    // Counts the number in `what` up from o.from (0) to o.to (the number written in it) over o.dur
    // (0.9 s) as the narration says `word`, easing out to land on the value. Give the element
    // tabular figures (class "num") so its width does not change while it counts.
    count: function (tl, what, id, word, o) {
      o = o || {};
      var e = el(what),
        written = e.textContent.replace(/[^\d.-]/g, "");
      var to = opt(o.to, parseFloat(written)),
        from = opt(o.from, 0);
      if (!isFinite(to)) throw new Error("film.count: no number in " + what + " and no o.to");
      var fmt = formatter(o, o.to === undefined ? written : to, /\d,\d/.test(e.textContent)),
        prefix = e.textContent.match(/^[^\d.-]*/)[0],
        suffix = e.textContent.match(/[^\d.,]*$/)[0],
        dur = opt(o.dur, 0.9);
      return over(tl, when(id, word, o), dur, function (t) {
        var p = 1 - Math.pow(1 - Math.min(1, t / dur), 3);
        e.textContent = prefix + fmt(t >= dur ? to : from + (to - from) * p) + suffix;
      });
    },
    // A line the narration of scene `id` says lights up with the voice: its text must be a stretch of
    // the narration (the n-th time it is said); every character starts dim (o.dim, 0.3) and turns
    // full as the voice reaches it. Mid-phrase characters are about 0.1 s off (scripts/words.ts).
    karaoke: function (tl, what, id, o) {
      o = o || {};
      var e = el(what),
        c = film.chars(e),
        text = c
          .map(function (s) {
            return s.textContent;
          })
          .join("")
          .replace(/ /g, " ");
      film.word(id, text, o.n); // the narration must say it: an error names the scene otherwise
      var whole = window.__words[id].text,
        i = -1;
      for (var n = 0; n < (o.n || 1); n++) i = whole.indexOf(text, i + 1);
      var times = film.times(id),
        k = Array.from(whole.slice(0, i)).length,
        lead = o.lead === undefined ? EARLY : o.lead;
      tl.set(c, { opacity: opt(o.dim, 0.3) }, 0);
      // each glyph span lights up as the voice reaches its first character
      c.forEach(function (s) {
        tl.to(
          s,
          { opacity: 1, duration: 0.12, ease: "none" },
          Math.max(0, film.at(id, times[k]) - lead)
        );
        k += Array.from(s.textContent).length;
      });
      return tl;
    },
  });
})();
