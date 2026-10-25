// Injected into an html film page for the layout check (render.ts). It lists what paints on screen
// now, as boxes in frame px; layout.ts decides which of them are mistakes. Plain JS because it runs
// in the page, not in Node.
(function () {
  var SIDES = ["Top", "Right", "Bottom", "Left"];
  var FRAME = { left: 0, top: 0, right: 1920, bottom: 1080 };
  var POINTS = [
    [0.5, 0.5],
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];

  function alpha(color) {
    var m = /rgba?\(([^)]*)\)/.exec(color);
    if (!m) return 0;
    var p = m[1].split(/[\s,/]+/).filter(Boolean);
    return p.length > 3 ? parseFloat(p[3]) : 1;
  }

  // [r, g, b, a] with r, g, b in 0-255, from rgb()/rgba() or color(srgb ...) (what color-mix()
  // computes to). null for any other color space.
  function rgba(color) {
    var m = /^rgba?\(([^)]*)\)/.exec(color);
    var p, k;
    if (m) {
      p = m[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(parseFloat);
      k = 1;
    } else {
      m = /^color\(srgb ([^)]*)\)/.exec(color);
      if (!m) return null;
      p = m[1]
        .split(/[\s/]+/)
        .filter(Boolean)
        .map(parseFloat);
      k = 255;
    }
    return [p[0] * k, p[1] * k, p[2] * k, p.length > 3 ? p[3] : 1];
  }

  function over(top, under) {
    var a = top[3];
    return [0, 1, 2].map(function (i) {
      return top[i] * a + under[i] * (1 - a);
    });
  }

  // What the element's own background looks like: its background and its ancestors' composited
  // from the page down. null when one of them is an image or gradient, or in an unknown space.
  function backdrop(el) {
    var layers = [];
    for (var e = el; e; e = e.parentElement) {
      var cs = getComputedStyle(e);
      if (cs.backgroundImage !== "none") return null;
      var c = rgba(cs.backgroundColor);
      if (!c) return null;
      if (c[3] > 0) layers.push(c);
    }
    return layers.reduceRight(
      function (under, c) {
        return over(c, under);
      },
      [255, 255, 255]
    );
  }

  function luminance(c) {
    var v = c.map(function (x) {
      var s = x / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }

  // WCAG contrast ratio of the text color over its backdrop, or null when it cannot be told.
  function contrast(el, cs) {
    var fg = rgba(cs.color),
      bg = backdrop(el);
    if (!fg || !bg) return null;
    var a = luminance(over(fg, bg)),
      b = luminance(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  // The size its own text is drawn at, after transforms, and its contrast. Contrast is left out
  // for text drawn faded (opacity under 0.9): dimmed on purpose, or fading in or out.
  function textOf(el, cs, shown) {
    if (!ownText(el) || el instanceof SVGElement) return null;
    var h = el.offsetHeight,
      scale = h > 0 ? el.getBoundingClientRect().height / h : 1;
    return {
      px: Math.round(parseFloat(cs.fontSize) * scale * 10) / 10,
      contrast: shown < 0.9 ? null : contrast(el, cs),
    };
  }

  function ownText(el) {
    return Array.prototype.some.call(el.childNodes, function (n) {
      return n.nodeType === 3 && n.textContent.trim() !== "";
    });
  }

  // How an element paints: "solid" (hides what is under it), "box" (border or faint fill),
  // "text" (glyphs only), or null (nothing of its own).
  function paint(el, cs) {
    if (/^(img|svg|canvas|video)$/i.test(el.tagName)) return "solid";
    if (alpha(cs.backgroundColor) >= 0.5 || cs.backgroundImage !== "none") return "solid";
    var border = SIDES.some(function (s) {
      return parseFloat(cs["border" + s + "Width"]) > 0 && alpha(cs["border" + s + "Color"]) > 0;
    });
    if (border || alpha(cs.backgroundColor) > 0) return "box";
    return ownText(el) ? "text" : null;
  }

  function opacity(el) {
    var o = 1;
    for (var e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  }

  function cross(a, b) {
    return {
      left: Math.max(a.left, b.left),
      top: Math.max(a.top, b.top),
      right: Math.min(a.right, b.right),
      bottom: Math.min(a.bottom, b.bottom),
    };
  }

  // The area an element's children may paint in: the frame cut by every overflow-clipping ancestor.
  function clipper() {
    var memo = new Map();
    return function clipOf(el) {
      if (!el || el === document.body || el === document.documentElement) return FRAME;
      if (memo.has(el)) return memo.get(el);
      var area = clipOf(el.parentElement);
      if (getComputedStyle(el).overflow !== "visible")
        area = cross(area, el.getBoundingClientRect());
      memo.set(el, area);
      return area;
    };
  }

  // Text without a box of its own takes the space of its glyphs, not of its (often wide) block.
  // A line's box is about 1.45em tall in Noto Sans JP while the glyphs fill about 1em of it, so
  // 0.2em is trimmed off the top and bottom; large numbers would otherwise overlap their labels.
  function rectOf(el, kind, cs) {
    if (kind !== "text") return el.getBoundingClientRect();
    var range = document.createRange();
    range.selectNodeContents(el);
    var r = range.getBoundingClientRect();
    var trim = Math.min(0.2 * parseFloat(cs.fontSize), (r.height - 1) / 2);
    return new DOMRect(r.x, r.y + trim, r.width, r.height - 2 * trim);
  }

  function label(el) {
    var name = el.id
      ? "#" + el.id
      : el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "");
    var text = el.textContent.replace(/\s+/g, " ").trim().slice(0, 24);
    return text ? name + ' "' + text + '"' : name;
  }

  function ancestors(el, keyOf) {
    var anc = [];
    for (var e = el.parentElement; e; e = e.parentElement) if (keyOf.has(e)) anc.push(keyOf.get(e));
    return anc;
  }

  function collect(all) {
    var clipOf = clipper();
    var keyOf = new Map();
    var boxes = [];
    all.forEach(function (el, key) {
      if (el === document.documentElement || el === document.body) return;
      if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) return;
      var cs = getComputedStyle(el);
      if (cs.visibility !== "visible" || cs.display === "none") return;
      var kind = paint(el, cs),
        shown = opacity(el);
      if (!kind || shown < 0.05) return;
      var r = rectOf(el, kind, cs);
      var v = cross(r, clipOf(el.parentElement));
      if (v.right - v.left < 1 || v.bottom - v.top < 1) return;
      keyOf.set(el, key);
      boxes.push({
        key: key,
        label: label(el),
        x: v.left,
        y: v.top,
        w: v.right - v.left,
        h: v.bottom - v.top,
        cut: r.left < -2 || r.top < -2 || r.right > 1922 || r.bottom > 1082,
        anc: ancestors(el, keyOf),
        ok: !!el.closest("[data-layout-ok]"),
        solid: kind === "solid",
        under: null,
        text: textOf(el, cs, shown),
      });
    });
    return { boxes: boxes, keyOf: keyOf };
  }

  // The topmost box at a point that is not b itself, its ancestor or its descendant, if it is
  // solid; null when b (or something of its own) is on top there.
  function coverAt(b, x, y, keyOf, byKey) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var p = stack[i];
      while (p && !keyOf.has(p)) p = p.parentElement;
      if (!p) continue;
      var o = byKey.get(keyOf.get(p));
      if (o === b || o.anc.indexOf(b.key) >= 0 || b.anc.indexOf(o.key) >= 0) return null;
      if (o.solid) return o;
    }
    return null;
  }

  // Hidden: at three or more of five points inside b, the same solid box is drawn over it.
  function markHidden(boxes, keyOf) {
    var byKey = new Map(
      boxes.map(function (b) {
        return [b.key, b];
      })
    );
    boxes.forEach(function (b) {
      var count = new Map();
      POINTS.forEach(function (pt) {
        var o = coverAt(b, b.x + b.w * pt[0], b.y + b.h * pt[1], keyOf, byKey);
        if (o) count.set(o.key, (count.get(o.key) || 0) + 1);
      });
      count.forEach(function (n, k) {
        if (n >= 3) b.under = k;
      });
    });
  }

  window.__layoutSnapshot = function () {
    var got = collect(Array.prototype.slice.call(document.querySelectorAll("*")));
    // Hit testing skips pointer-events: none, which says nothing about what is drawn on top.
    var style = document.createElement("style");
    style.textContent = "* { pointer-events: auto !important; }";
    document.head.append(style);
    try {
      markHidden(got.boxes, got.keyOf);
    } finally {
      style.remove();
    }
    return got.boxes;
  };
})();
