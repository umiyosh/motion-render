import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCRIPT, tempDir, wav, workDir } from "./helpers.ts";

// ffmpeg is never run in unit tests: spawn records its arguments and exits with `exitCode`.
const ffmpeg = vi.hoisted(() => ({ calls: [] as { cmd: string; args: string[] }[], exitCode: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (cmd: string, args: string[]) => {
      ffmpeg.calls.push({ cmd, args });
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", ffmpeg.exitCode));
      return child;
    },
  };
});

const { bgm, bgmFile, encodeArgs, findFfmpeg, mix, narrate, wavSeconds } =
  await import("../skills/motion-render/scripts/audio.ts");
const { loadScript } = await import("../skills/motion-render/scripts/work.ts");

const audioResponse = (mimeType: string, data: Buffer) =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: "ok" }, { inlineData: { mimeType, data: data.toString("base64") } }],
          },
        },
      ],
    }),
    { status: 200 }
  );

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.stubEnv("FFMPEG_PATH", "/usr/bin/ffmpeg-test");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
  ffmpeg.calls = [];
  ffmpeg.exitCode = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("narrate", () => {
  it("asks the TTS model for each scene with the voice and stores WAV, wrapping raw PCM in a header", async () => {
    const dir = workDir(SCRIPT);
    const pcm = Buffer.alloc(48000); // 1 s of 16-bit mono at 24 kHz
    fetchMock.mockImplementation(async () => audioResponse("audio/L16;codec=pcm;rate=24000", pcm));
    await narrate(dir, loadScript(dir));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent"
    );
    expect(init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      contents: [{ parts: [{ text: "はじめに" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    expect(wavSeconds(join(dir, "audio", "intro.wav"))).toBe(1);
    expect(readFileSync(join(dir, "audio", "flow.txt"), "utf8")).toBe("流れ");
  });

  it("keeps a WAV response as it is and skips scenes whose narration did not change", async () => {
    const dir = workDir(SCRIPT);
    fetchMock.mockImplementation(async () => audioResponse("audio/wav", wav(0.5)));
    await narrate(dir, loadScript(dir));
    expect(wavSeconds(join(dir, "audio", "intro.wav"))).toBe(0.5);

    writeFileSync(
      join(dir, "script.json"),
      JSON.stringify({ ...SCRIPT, scenes: [SCRIPT.scenes[0], { id: "flow", narration: "変えた" }] })
    );
    fetchMock.mockClear();
    await narrate(dir, loadScript(dir));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries three times and reports the API's error message", async () => {
    const dir = workDir(SCRIPT);
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 })
    );
    await expect(narrate(dir, loadScript(dir))).rejects.toThrow(
      "gemini-3.8-flash-tts: HTTP 429 quota exceeded"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("fails when the response has no audio", async () => {
    const dir = workDir(SCRIPT);
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 })
    );
    await expect(narrate(dir, loadScript(dir))).rejects.toThrow("no audio in the response");
  });

  it("needs GEMINI_API_KEY", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");
    const dir = workDir(SCRIPT);
    await expect(narrate(dir, loadScript(dir))).rejects.toThrow("GEMINI_API_KEY is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("bgm", () => {
  it("asks for an instrumental a little longer than the film and remembers the file", async () => {
    const dir = workDir(SCRIPT);
    fetchMock.mockImplementation(async () => audioResponse("audio/mpeg", Buffer.from("mp3")));
    const file = await bgm(dir, loadScript(dir), 60.2);

    expect(file).toBe(join(dir, "audio", "bgm.mp3"));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/lyria-3.5:generateContent");
    const prompt = JSON.parse(readFileSync(join(dir, "audio", "bgm.json"), "utf8"))
      .prompt as string;
    expect(prompt).toMatch(/^calm synth\n\nInstrumental only, no vocals\. About 71 seconds long\./);
    expect(bgmFile(dir)).toBe(file);
  });

  it("stores a WAV answer as bgm.wav", async () => {
    const dir = workDir(SCRIPT);
    fetchMock.mockImplementation(async () => audioResponse("audio/wav", wav(1)));
    expect(await bgm(dir, loadScript(dir), 1)).toBe(join(dir, "audio", "bgm.wav"));
  });

  it("asks for bgm when there is none yet, and for a new one when bgm.json is broken", () => {
    const dir = workDir(SCRIPT);
    expect(() => bgmFile(dir)).toThrow(/no BGM yet: run "motion-render bgm/);
    writeFileSync(join(dir, "audio", "bgm.json"), "{}");
    expect(() => bgmFile(dir)).toThrow(/bgm\.json is malformed/);
  });
});

describe("wavSeconds", () => {
  it("rejects a file that is not PCM WAV", () => {
    const file = join(tempDir(), "x.wav");
    writeFileSync(file, Buffer.from("RIFF0000WAVEjunk"));
    expect(() => wavSeconds(file)).toThrow("not a PCM WAV file");
  });
});

describe("findFfmpeg", () => {
  it("prefers FFMPEG_PATH", () => {
    expect(findFfmpeg()).toBe("/usr/bin/ffmpeg-test");
  });
});

describe("mix", () => {
  it("places each narration at its scene start plus lead and loops the BGM at a fixed level under it", async () => {
    const dir = workDir({ ...SCRIPT, speed: 1.2, bgmVolume: 0.2, lead: 0.5 });
    writeFileSync(join(dir, "audio", "bgm.json"), JSON.stringify({ file: "bgm.mp3" }));
    const out = join(dir, "audio", "mix.m4a");
    await mix(
      dir,
      loadScript(dir),
      {
        scenes: [
          { id: "intro", start: 0 },
          { id: "flow", start: 4.25 },
        ],
        total: 10,
      },
      out
    );

    expect(ffmpeg.calls).toHaveLength(1);
    const { cmd, args } = ffmpeg.calls[0]!;
    expect(cmd).toBe("/usr/bin/ffmpeg-test");
    expect(args.slice(0, 3)).toEqual(["-y", "-loglevel", "error"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "-i",
        join(dir, "audio", "intro.wav"),
        "-i",
        join(dir, "audio", "flow.wav"),
      ])
    );
    expect(args.join(" ")).toContain(`-stream_loop -1 -i ${join(dir, "audio", "bgm.mp3")}`);
    const graph = args[args.indexOf("-filter_complex") + 1]!;
    expect(graph).toContain("[0:a]atempo=1.2,adelay=500:all=1[n0]");
    expect(graph).toContain("[1:a]atempo=1.2,adelay=4750:all=1[n1]");
    expect(graph).toContain("[2:a]atrim=0:10,");
    expect(graph).toContain("volume=0.2,afade=t=in:d=0.8,afade=t=out:st=7:d=3[bgm]");
    expect(graph.split(";").at(-1)).toBe(
      "[nar][bgm]amix=inputs=2:normalize=0,alimiter=limit=0.95[out]"
    );
    expect(args.slice(-9)).toEqual([
      "-map",
      "[out]",
      "-t",
      "10",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      out,
    ]);
  });

  it("cuts, levels and fades each sound effect, delays it to its time and mixes it with the rest", async () => {
    const dir = workDir(SCRIPT);
    writeFileSync(join(dir, "audio", "bgm.json"), JSON.stringify({ file: "bgm.mp3" }));
    await mix(
      dir,
      loadScript(dir),
      {
        scenes: [{ id: "intro", start: 0 }],
        total: 6,
        sfx: [
          { file: "/w/pop.mp3", start: 1.25, duration: 0.6, gain: 2.5 },
          { file: "/w/whoosh.mp3", start: 3, duration: 1.5, gain: 0.123456 },
        ],
      },
      join(dir, "m.m4a")
    );

    const { args } = ffmpeg.calls[0]!;
    expect(args.join(" ")).toContain("-i /w/pop.mp3 -i /w/whoosh.mp3 -filter_complex");
    const graph = args[args.indexOf("-filter_complex") + 1]!.split(";");
    expect(graph).toContain(
      "[2:a]atrim=0:0.6,asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=2.5000,afade=t=in:d=0.01,afade=t=out:st=0.4:d=0.2,adelay=1250:all=1[s0]"
    );
    expect(graph).toContain(
      "[3:a]atrim=0:1.5,asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,volume=0.1235,afade=t=in:d=0.01,afade=t=out:st=1.25:d=0.25,adelay=3000:all=1[s1]"
    );
    expect(graph.at(-1)).toBe(
      "[nar][bgm][s0][s1]amix=inputs=4:normalize=0,alimiter=limit=0.95[out]"
    );
  });

  it("reports an ffmpeg failure", async () => {
    const dir = workDir(SCRIPT);
    writeFileSync(join(dir, "audio", "bgm.json"), JSON.stringify({ file: "bgm.mp3" }));
    ffmpeg.exitCode = 1;
    await expect(
      mix(
        dir,
        loadScript(dir),
        { scenes: [{ id: "intro", start: 0 }], total: 3 },
        join(dir, "m.m4a")
      )
    ).rejects.toThrow("ffmpeg exited with code 1");
    expect(existsSync(join(dir, "m.m4a"))).toBe(false);
  });
});

describe("encodeArgs", () => {
  it("reads PNG frames from stdin at the frame rate and muxes the mixed audio into a streamable MP4", () => {
    const args = encodeArgs(24, "/w/mix.m4a", "/out/film.mp4");
    expect(args.join(" ")).toBe(
      "-y -loglevel error -f image2pipe -framerate 24 -i - -i /w/mix.m4a -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -c:a aac -b:a 192k -shortest -movflags +faststart /out/film.mp4"
    );
  });
});
