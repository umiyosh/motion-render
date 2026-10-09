# motion-render

English | [日本語](README.ja.md)

An Agent Skill that turns a theme into an **animated explainer video with narration and background music, rendered to MP4**.

```
/motion-render:motion-render Make a video that explains how GitHub Actions authenticates to Google Cloud with Workload Identity Federation
```

From that one line, Claude writes a storyboard and a narration script, generates the narration (Gemini TTS) and BGM that fits the theme (Lyria), builds the animation with Claude **Motion**, and renders it to an MP4 on your machine.

## Demo

An introduction video made by motion-render itself (59 seconds, with sound; the narration is in Japanese).

https://github.com/user-attachments/assets/19187fdb-75d3-469c-b704-6ff844cff49e

![How motion-render works](docs/how-it-works.svg)

- Look, length, voice and the mood of the music are chosen from the theme (anything you specify wins)
- You can also pass the URL of an existing Motion film to get an MP4 with narration and BGM
- The rendering browser (Chromium) and ffmpeg are set up automatically, so results don't depend on what is installed on your machine

## Requirements

| What | Notes |
|------|-------|
| Claude Code | An account that can use Artifacts (Motion) |
| Node.js 18 or later | Check with `node -v` |
| Gemini API key | Used for narration and BGM. Create one in [Google AI Studio](https://aistudio.google.com/apikey) |

Works on macOS, Linux and Windows.

## Install

### 1. Install

**Claude Code (recommended): install it as a plugin.** Run this inside Claude Code:

```
/plugin install motion-render --marketplace umiyosh/motion-render
```

On Claude Code versions before 2.1.275, run it as two lines:

```
/plugin marketplace add umiyosh/motion-render
/plugin install motion-render@motion-render
```

The rendering command and its dependencies come with the plugin, so there is nothing else to install.
Plugin skills are prefixed with the plugin name, so you call it as `/motion-render:motion-render <theme>`.

**Other agents (Codex, Cursor, …): install with the skills CLI**

```sh
npx skills add umiyosh/motion-render -g
```

This installs the skill only. On first use, the agent installs the `motion-render` command with `npm install -g`.
If your environment blocks that (a sandbox, for example) and you use Claude Code, install it as a plugin instead.

### 2. Set the API key

Add this to your shell profile (`~/.zshrc` or similar) and restart Claude Code.

```sh
export GEMINI_API_KEY="your key"
```

### 3. Only if you use the Claude Code sandbox: add settings

Chromium cannot start inside the sandbox. Add these two entries to `~/.claude/settings.json` so that only `motion-render` runs outside it.

```jsonc
{
  "sandbox": {
    "excludedCommands": ["motion-render:*"]   // add to the existing array
  },
  "permissions": {
    "allow": ["Bash(motion-render:*)"]        // add to the existing array
  }
}
```

If you use auto mode and runs are still refused, also add this line to `autoMode.environment`:

```jsonc
"**Motion rendering**: rendering Motion films to MP4 with headless Chromium via the `motion-render` command, outside the Bash sandbox, is routine work requested by the user"
```

### 4. Make your first video

```
/motion-render:motion-render Make a 30-second video that explains …
```

(If you installed with the skills CLI: `/motion-render Make a …`)

On the first run, Chromium (about 210 MB) and ffmpeg are downloaded automatically.

## Usage

- Add length, output location or mood in the same request (e.g. "30 seconds", "save it to `~/Movies`", "news-style BGM")
- Without an output location, the video goes to `$MOTION_RENDER_OUT_DIR`, or the current directory
- After it is done, ask "change the BGM" or "shorten this part" and only that part is redone
- For an existing Motion film, pass its URL and ask for an MP4. Narration and BGM are added too

### Commands (used by Claude under the hood)

Each video uses one work directory (`<work>`). Its layout and the `script.json` format are in [SKILL.md](skills/motion-render/SKILL.md).

| Command | What it does |
|---------|--------------|
| `motion-render narrate <work>` | Generates narration from `script.json` and writes scene lengths to `timing.json` |
| `motion-render bgm <work>` | Generates the BGM from the `bgm` prompt in `script.json` |
| `motion-render prepare <storeDir> <work>/film` | Expands a Motion film's data into a directory it can render |
| `motion-render stills <filmDir> <outDir> 0,5,12` | Writes still frames for checking |
| `motion-render build <work> [out.mp4]` | Mixes narration and BGM and renders the MP4 (stops if either is missing) |
| `motion-render --version` | Prints the version |

| Environment variable | Effect |
|----------------------|--------|
| `GEMINI_API_KEY` | Required for narration and BGM |
| `MOTION_RENDER_OUT_DIR` | Default output directory when `build` gets no output path |
| `CHROMIUM_PATH` | Use your own Chrome or Chromium instead of the bundled one |
| `FFMPEG_PATH` | Use your own ffmpeg instead of the bundled one |

## Troubleshooting

| Symptom | Cause and fix |
|---------|---------------|
| The browser fails with `bootstrap_check_in ... Permission denied` | It is running inside the Claude Code sandbox. Check step 3 of the install. `motion-render` must run on its own (chaining it with `\| grep` or `&&` keeps it in the sandbox) |
| `GEMINI_API_KEY is not set` | Check step 2 of the install and restart Claude Code |
| Narration or BGM generation keeps failing | Each request times out after 90 seconds and is retried up to 3 times. If it still fails, check your API key's permissions and quota |
| ffmpeg fails to download | A proxy is blocking downloads from GitHub. Install ffmpeg yourself (it is used from `PATH`) or point `FFMPEG_PATH` at it |
| Chromium fails to download on first run | Point `CHROMIUM_PATH` at your own Chrome or Chromium |
| Japanese glyphs or line breaks differ slightly from the Motion page | Text is drawn with your OS fonts |

## Uninstall

If you installed the plugin, run this inside Claude Code:

```
/plugin uninstall motion-render
```

If you used the skills CLI, run this in your shell:

```sh
npx skills remove motion-render -g
npm uninstall -g motion-render
```

The downloaded Chromium is in Playwright's cache (`~/Library/Caches/ms-playwright` on macOS, `~/.cache/ms-playwright` on Linux). Delete it if you no longer need it.

## Security

- While rendering, the film's code cannot reach the network or read files outside the film directory
- Chromium starts with its own sandbox enabled (Playwright disables it by default, so it is turned on explicitly)
- Only the `motion-render` command is taken out of the Claude Code sandbox
- The API key is read from the environment only and is never written to files or videos

## Layout

```
.claude-plugin/
  marketplace.json        # Claude Code plugin catalog (lists this repository itself)
  plugin.json             # Plugin manifest
bin/motion-render         # Command the plugin puts on PATH (runs the CLI in skills/motion-render)
package.json              # Plugin dependencies, installed by Claude Code with the plugin
package-lock.json
skills/motion-render/     # The skill (read by both the skills CLI and the plugin)
  SKILL.md                # Instructions for Claude (setup, storyboard, script and BGM choices)
  package.json            # The motion-render command and pinned dependencies (playwright-core, ffmpeg-static)
  scripts/cli.mjs         # The motion-render command
  scripts/audio.mjs       # Narration and BGM generation, audio mixing
  scripts/work.mjs        # script.json validation and scene timing
  scripts/render.mjs      # Rendering in the browser
docs/how-it-works.svg     # Diagram used in the README (Japanese labels)
```
