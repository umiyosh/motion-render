// A stand-in for the Motion player with the same hook (window.__animation) that motion-render drives.
// It lays the scenes of modules/scenes.json end to end and draws the current scene's index as a color.
(function () {
  var logs = [];
  var parts = [];
  var colors = ["#c0392b", "#27ae60", "#2980b9", "#f39c12"];
  window.__animation = {
    load: async function (film) {
      if (film.script.indexOf("FAIL") >= 0) return { error: { message: "cut.js threw" } };
      var scenes = film.modules.find(function (m) {
        return m.name === "scenes.json";
      });
      var list = JSON.parse(scenes.text).scenes;
      var a0 = 0;
      parts = list.map(function (s) {
        var p = { key: s.id, a0: a0, dur: s.dur };
        a0 += s.dur;
        return p;
      });
      try {
        await fetch("https://example.com/");
        logs.push({ level: "warn", text: "network: reachable" });
      } catch (e) {
        logs.push({ level: "warn", text: "network: blocked" });
      }
      logs.push({ level: "log", text: "loaded " + film.modules.length + " modules" });
      return { meta: { duration: a0, parts: parts } };
    },
    frame: function (t) {
      var c = document.getElementById("c");
      var g = c.getContext("2d");
      var i = parts.findIndex(function (p) {
        return t >= p.a0 && t < p.a0 + p.dur;
      });
      g.fillStyle = colors[(i < 0 ? parts.length - 1 : i) % colors.length];
      g.fillRect(0, 0, c.width, c.height);
      return c.toDataURL("image/png");
    },
    consoleLog: function () {
      return logs;
    },
  };
})();
