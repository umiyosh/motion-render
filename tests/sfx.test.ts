import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT, workDir } from "./helpers.ts";

// ffmpeg is never run: spawn records its arguments, prints `log` on stderr (what volumedetect would
// report) and exits with `exitCode`.
const ffmpeg = vi.hoisted(() => ({
  calls: [] as string[][],
  exitCode: 0,
  log: "mean_volume: -50.0 dB\nmax_volume: -32.4 dB\n",
}));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (_cmd: string, args: string[]) => {
      ffmpeg.calls.push(args);
      const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
      setImmediate(() => {
        child.stderr.emit("data", Buffer.from(ffmpeg.log));
        child.emit("close", ffmpeg.exitCode);
      });
      return child;
    },
  };
});

const { checkSfx, makeSfx, narrationLevel, previewSfx, sfxKey, sfxTrack } =
  await import("../skills/motion-render/scripts/sfx.ts");
const { volumeStats } = await import("../skills/motion-render/scripts/audio.ts");
const { loadScript } = await import("../skills/motion-render/scripts/work.ts");

const pop = { at: 1, prompt: "soft UI pop", duration: 0.8 };
const whoosh = { at: 0.5, prompt: "quick airy whoosh" };
// intro: pop, whoosh; flow: the same pop again.
const SFX_SCRIPT = {
  ...SCRIPT,
  scenes: [
    { ...SCRIPT.scenes[0], sfx: [pop, whoosh] },
    { ...SCRIPT.scenes[1], sfx: [{ ...pop, at: 2 }] },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("ELEVENLABS_API_KEY", "el-key");
  vi.stubEnv("FFMPEG_PATH", "/usr/bin/ffmpeg-test");
  fetchMock = vi.fn(async () => new Response(Buffer.from("mp3"), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  ffmpeg.calls = [];
  ffmpeg.exitCode = 0;
  ffmpeg.log = "mean_volume: -50.0 dB\nmax_volume: -32.4 dB\n";
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sfxPath = (dir: string, prompt: string, duration: number, ext: string) =>
  join(dir, "audio", "sfx", `${sfxKey(prompt, duration)}.${ext}`);

describe("makeSfx", () => {
  it("asks ElevenLabs once per distinct effect and stores the MP3 with its measured level", async () => {
    const dir = workDir(SFX_SCRIPT);
    expect(await makeSfx(dir, loadScript(dir))).toBe(2);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128");
    expect(init.headers).toMatchObject({ "xi-api-key": "el-key" });
    expect(JSON.parse(String(init.body))).toEqual({
      text: "soft UI pop",
      duration_seconds: 0.8,
      model_id: "eleven_text_to_sound_v2",
    });
    expect(
      JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))
    ).toMatchObject({
      text: "quick airy whoosh",
      duration_seconds: 1.5,
    });
    expect(readFileSync(sfxPath(dir, "soft UI pop", 0.8, "mp3"), "utf8")).toBe("mp3");
    expect(JSON.parse(readFileSync(sfxPath(dir, "soft UI pop", 0.8, "json"), "utf8"))).toEqual({
      prompt: "soft UI pop",
      duration: 0.8,
      mean: -50,
      max: -32.4,
    });
  });

  it("keeps effects that were already made", async () => {
    const dir = workDir(SFX_SCRIPT);
    await makeSfx(dir, loadScript(dir));
    fetchMock.mockClear();
    expect(await makeSfx(dir, loadScript(dir))).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing, and needs no key, when the script has no sound effects", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const dir = workDir(SCRIPT);
    expect(await makeSfx(dir, loadScript(dir))).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs ELEVENLABS_API_KEY when there is something to make", async () => {
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    const dir = workDir(SFX_SCRIPT);
    await expect(makeSfx(dir, loadScript(dir))).rejects.toThrow("ELEVENLABS_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a silent result as a failure, retries it and does not keep it", async () => {
    ffmpeg.log = "mean_volume: -91.0 dB\nmax_volume: -91.0 dB\n";
    const dir = workDir({ ...SCRIPT, scenes: [{ ...SCRIPT.scenes[0], sfx: [pop] }] });
    await expect(makeSfx(dir, loadScript(dir))).rejects.toThrow(
      'sound effect "soft UI pop" came back silent (peak -91 dB)'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(existsSync(sfxPath(dir, "soft UI pop", 0.8, "json"))).toBe(false);
  });

  it.each([
    [
      422,
      { detail: [{ loc: ["body", "text"], msg: "field required" }] },
      "HTTP 422 field required",
    ],
    [
      401,
      { detail: { status: "invalid_api_key", message: "Invalid API key" } },
      "HTTP 401 Invalid API key",
    ],
    [500, "oops", "HTTP 500"],
  ])("reports the API's reason for HTTP %i", async (status, body, message) => {
    fetchMock.mockImplementation(
      async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })
    );
    const dir = workDir({ ...SCRIPT, scenes: [{ ...SCRIPT.scenes[0], sfx: [pop] }] });
    await expect(makeSfx(dir, loadScript(dir))).rejects.toThrow(
      `sound effect "soft UI pop": ${message}`
    );
  });
});

describe("sfxTrack", () => {
  const meta = (dir: string, prompt: string, duration: number, mean: number, max: number) =>
    writeFileSync(
      sfxPath(dir, prompt, duration, "json"),
      JSON.stringify({ prompt, duration, mean, max })
    );

  it("brings a quiet effect to 4 dB under the narration's average level", async () => {
    const dir = workDir(SFX_SCRIPT);
    await makeSfx(dir, loadScript(dir));
    meta(dir, "soft UI pop", 0.8, -50, -32);
    const t = sfxTrack(dir, { ...pop, volume: 1, start: 3 }, -16);
    expect(t).toMatchObject({
      file: sfxPath(dir, "soft UI pop", 0.8, "mp3"),
      start: 3,
      duration: 0.8,
    });
    expect(t.gain).toBeCloseTo(10 ** (30 / 20), 6); // -50 dB -> -20 dB
  });

  it("lowers an effect by its volume", async () => {
    const dir = workDir(SFX_SCRIPT);
    await makeSfx(dir, loadScript(dir));
    meta(dir, "soft UI pop", 0.8, -50, -32);
    const t = sfxTrack(dir, { ...pop, volume: 0.5, start: 0 }, -10);
    expect(t.gain).toBeCloseTo(0.5 * 10 ** (36 / 20), 6); // -50 dB -> -14 dB, then halved
  });

  it("stops short of clipping a loud effect, and still lowers it by its volume", async () => {
    const dir = workDir(SFX_SCRIPT);
    await makeSfx(dir, loadScript(dir));
    meta(dir, "quick airy whoosh", 1.5, -21.5, 0);
    const loud = { ...whoosh, duration: 1.5, start: 0 };
    expect(sfxTrack(dir, { ...loud, volume: 1 }, -16).gain).toBeCloseTo(10 ** (-1 / 20), 6); // peak held at -1 dB
    expect(sfxTrack(dir, { ...loud, volume: 0.1 }, -16).gain).toBeCloseTo(
      0.1 * 10 ** (1.5 / 20),
      6
    );
  });
});

describe("narrationLevel", () => {
  it("averages the narration's level over the scenes", async () => {
    ffmpeg.log = "mean_volume: -14.0 dB\nmax_volume: -1.0 dB\n";
    const dir = workDir(SFX_SCRIPT, { intro: 1, flow: 1 });
    expect(await narrationLevel(dir, loadScript(dir))).toBe(-14);
    expect(ffmpeg.calls.map((a) => a[a.indexOf("-i") + 1])).toEqual([
      join(dir, "audio", "intro.wav"),
      join(dir, "audio", "flow.wav"),
    ]);
  });

  it("assumes Gemini TTS's usual level before there is any narration", async () => {
    const dir = workDir(SFX_SCRIPT);
    expect(await narrationLevel(dir, loadScript(dir))).toBe(-16);
    expect(ffmpeg.calls).toEqual([]);
  });
});

describe("checkSfx", () => {
  it("names the effects that were not made yet", async () => {
    const dir = workDir(SFX_SCRIPT);
    expect(() => checkSfx(dir, loadScript(dir))).toThrow(
      `sound effects missing for: "soft UI pop", "quick airy whoosh" (run "motion-render sfx ${dir}")`
    );
    await makeSfx(dir, loadScript(dir));
    expect(() => checkSfx(dir, loadScript(dir))).not.toThrow();
  });
});

describe("previewSfx", () => {
  it("writes every effect in script order at its mixing level, with a gap after each", async () => {
    const dir = workDir(SFX_SCRIPT);
    await makeSfx(dir, loadScript(dir));
    ffmpeg.calls = [];
    const preview = await previewSfx(dir, loadScript(dir));

    expect(preview?.file).toBe(join(dir, "audio", "sfx", "preview.m4a"));
    expect(preview?.list).toEqual([
      { offset: 0, scene: "intro", at: 1, prompt: "soft UI pop" },
      { offset: 1.4, scene: "intro", at: 0.5, prompt: "quick airy whoosh" },
      { offset: 3.5, scene: "flow", at: 2, prompt: "soft UI pop" },
    ]);
    const args = ffmpeg.calls[0]!;
    const graph = args[args.indexOf("-filter_complex") + 1]!.split(";");
    expect(graph[0]).toMatch(/^\[0:a\]atrim=0:0\.8,.*adelay=0:all=1\[s0\]$/);
    expect(graph).toContain("[s0]apad=pad_dur=0.6[p0]");
    expect(graph.at(-1)).toBe("[p0][p1][p2]concat=n=3:v=0:a=1[out]");
    expect(args.at(-1)).toBe(preview?.file);
  });

  it("returns null when there is nothing to listen to", async () => {
    const dir = workDir(SCRIPT);
    expect(await previewSfx(dir, loadScript(dir))).toBeNull();
    expect(ffmpeg.calls).toEqual([]);
  });
});

describe("volumeStats", () => {
  it("reads -inf as a very low level", async () => {
    ffmpeg.log = "mean_volume: -inf dB\nmax_volume: -inf dB\n";
    expect(await volumeStats("/x.mp3")).toEqual({ mean: -120, max: -120 });
  });

  it("fails when ffmpeg reports no level", async () => {
    ffmpeg.log = "Invalid data found when processing input\n";
    ffmpeg.exitCode = 1;
    await expect(volumeStats("/x.mp3")).rejects.toThrow("could not measure the level of /x.mp3");
  });
});
