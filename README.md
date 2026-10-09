# motion-render

テーマを伝えるだけで、それを説明する**アニメーション動画を作り、ナレーションと BGM を付けて MP4 にする** Agent Skill です。

```
/motion-render Workload Identity Federation による GitHub Actions から Google Cloud への認証の仕組みを説明する動画つくって
```

この一言で、Claude が絵コンテと原稿を書きます。続けて、ナレーション（Gemini TTS）とテーマに合う BGM（Lyria）を作ります。最後に、Claude の **Motion** でアニメーションを作り、手元の MP4 に書き出します。

![motion-render の仕組み](docs/how-it-works.svg)

- 見た目・長さ・声・BGM の雰囲気はテーマから自動で決まります（指定すればそれに従います）
- 既存の Motion の動画の URL を渡して、ナレーションと BGM 付きの MP4 にすることもできます
- 描画用のブラウザ（Chromium）と ffmpeg は自動で用意されるので、環境ごとの差が出ません

## 必要なもの

| もの | 備考 |
|------|------|
| Claude Code | Artifact（Motion）を扱えるアカウント |
| Node.js 18 以上 | `node -v` で確認 |
| Gemini API キー | ナレーションと BGM に使います。[Google AI Studio](https://aistudio.google.com/apikey) で発行します |

macOS・Linux・Windows で動きます。

## インストール

### 1. 入れる

**Claude Code の場合（推奨）: プラグインとして入れる**。Claude Code の中で実行します。

```
/plugin install motion-render --marketplace umiyosh/motion-render
```

Claude Code 2.1.275 より前の版では、2 行に分けて実行します。

```
/plugin marketplace add umiyosh/motion-render
/plugin install motion-render@motion-render
```

描画用のコマンドと部品も一緒に入るので、ほかに入れるものはありません。
プラグインのスキルは名前の前にプラグイン名が付くので、使うときは `/motion-render:motion-render <テーマ>` です。

**ほかのエージェント（Codex・Cursor など）の場合: skills CLI で入れる**

```sh
npx skills add umiyosh/motion-render -g
```

スキルだけが入るので、初回に Claude（エージェント）が `motion-render` コマンドを `npm install -g` で入れます。
sandbox などで入れられない環境では、Claude Code ならプラグインとして入れてください。

### 2. API キーを設定する

シェルの設定ファイル（`~/.zshrc` など）に足して、Claude Code を起動し直します。

```sh
export GEMINI_API_KEY="発行したキー"
```

### 3. Claude Code の sandbox を使っている場合だけ: 設定を足す

sandbox の中では描画用のブラウザが起動できません。`~/.claude/settings.json` に次の 2 つを足し、`motion-render` だけを sandbox の外で動かします。

```jsonc
{
  "sandbox": {
    "excludedCommands": ["motion-render:*"]   // 既存の配列に追加
  },
  "permissions": {
    "allow": ["Bash(motion-render:*)"]        // 既存の配列に追加
  }
}
```

auto mode を使っていて、それでも実行が拒否される場合は、`autoMode.environment` に次の 1 行も足してください。

```jsonc
"**Motion rendering**: rendering Motion films to MP4 with headless Chromium via the `motion-render` command, outside the Bash sandbox, is routine work requested by the user"
```

### 4. 最初の 1 本を作る

```
/motion-render:motion-render 〇〇を説明する 30 秒の動画つくって
```

（skills CLI で入れた場合は `/motion-render 〇〇を…`）

初回は、描画用の Chromium（約 210 MB）と ffmpeg が自動でダウンロードされます。

## 使い方

- 長さ・出力先・雰囲気などは、続けて書けば反映されます（例:「30 秒で」「`~/Movies` に出して」「BGM はニュース風」）
- 出力先を言わなければ、`$MOTION_RENDER_OUT_DIR`、無ければカレントディレクトリに保存されます
- できた後に「BGM を変えて」「ここの説明を短く」と頼めば、その部分だけ作り直します
- 既存の Motion の動画なら、URL を渡して「MP4 にして」と頼みます。ナレーションと BGM も付きます

### コマンド（Claude が内部で使うもの）

動画 1 本ごとに作業フォルダ（`<work>`）を 1 つ使います。中身と `script.json` の書き方は [SKILL.md](skills/motion-render/SKILL.md) にあります。

| コマンド | やること |
|----------|----------|
| `motion-render narrate <work>` | `script.json` の原稿からナレーションを作り、場面の秒数を `timing.json` に書く |
| `motion-render bgm <work>` | `script.json` の `bgm` の指示から BGM を作る |
| `motion-render prepare <storeDir> <work>/film` | Motion から取得した映像データを、描画できる形に展開する |
| `motion-render stills <filmDir> <outDir> 0,5,12` | 確認用の静止画を書き出す |
| `motion-render build <work> [out.mp4]` | ナレーションと BGM を合成し、映像と合わせて MP4 にする（どちらかが無いと止まる） |
| `motion-render --version` | 版を表示する |

| 環境変数 | 効果 |
|----------|------|
| `GEMINI_API_KEY` | ナレーションと BGM の生成に必要 |
| `MOTION_RENDER_OUT_DIR` | `build` の出力先を省略したときの保存先 |
| `CHROMIUM_PATH` | 同梱の Chromium の代わりに、手元の Chrome や Chromium を使う |
| `FFMPEG_PATH` | 同梱の ffmpeg の代わりに、手元の ffmpeg を使う |

## 困ったとき

| 症状 | 原因と対処 |
|------|------------|
| `bootstrap_check_in ... Permission denied` でブラウザが起動しない | Claude Code の sandbox の中で動いています。インストールの手順 3 を確認してください。`motion-render` は単体で実行する必要があります（`\| grep` や `&&` でつなぐと sandbox の外に出ません） |
| `GEMINI_API_KEY is not set` | インストールの手順 2 を確認し、Claude Code を起動し直してください |
| ナレーションや BGM の生成が何度も失敗する | 1 回 90 秒で打ち切り、3 回まで再試行します。それでも失敗するなら、API キーの権限と利用上限を確認してください |
| `motion-render` のインストールで ffmpeg のダウンロードが失敗する | 社内プロキシなどで GitHub からの取得が止められています。`npm install -g --ignore-scripts <スキルのフォルダ>` で入れ、手元の ffmpeg を `FFMPEG_PATH` で指定してください（PATH 上の `ffmpeg` も自動で使います） |
| 初回の Chromium のダウンロードが失敗する | `CHROMIUM_PATH` に手元の Chrome か Chromium を指定してください |
| 日本語の字形や改行位置が Motion のページと少し違う | 文字は OS のフォントで描かれます |

## アンインストール

```sh
npm uninstall -g motion-render
npx skills remove motion-render -g        # A で入れた場合
```

B で入れた場合は、Claude Code の中で `/plugin uninstall motion-render` を実行します。

ダウンロードした Chromium は Playwright のキャッシュ（macOS は `~/Library/Caches/ms-playwright`、Linux は `~/.cache/ms-playwright`）にあります。不要なら消してください。

## 安全性

- 描画中、動画のコードは外部への通信をすべて遮断され、映像データのフォルダの外のファイルも読めません
- Chromium 自身の sandbox を有効にして起動します（Playwright は既定で無効にするため、明示的に有効にしています）
- Claude Code の sandbox から外すのは `motion-render` コマンドだけです
- API キーは環境変数から読むだけで、ファイルや動画には残しません

## 構成

```
.claude-plugin/
  marketplace.json        # Claude Code のプラグイン一覧（このリポジトリ自身を載せる）
  plugin.json             # プラグインの名札
bin/motion-render         # プラグインが PATH に載せるコマンド（skills/motion-render の CLI を呼ぶ）
package.json              # プラグインの依存。Claude Code がプラグインを入れるときに自動で入れる
package-lock.json
skills/motion-render/     # スキル本体（skills CLI とプラグインの両方がここを読む）
  SKILL.md                # Claude が読む手順（準備、絵コンテ・原稿・BGM の決め方を含む）
  package.json            # motion-render コマンドと、依存の版（playwright-core, ffmpeg-static）
  scripts/cli.mjs         # motion-render コマンド
  scripts/audio.mjs       # ナレーションと BGM の生成、音声の合成
  scripts/work.mjs        # script.json の検証と場面の秒数の計算
  scripts/render.mjs      # ブラウザで描画する部分
docs/how-it-works.svg     # README の図
```
