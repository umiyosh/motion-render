# motion-render

[English](README.md) | 日本語

テーマを伝えるだけで、それを説明する**アニメーション動画を作り、ナレーションと BGM を付けて MP4 にする** Agent Skill です。

```
/motion-render:motion-render Workload Identity Federation による GitHub Actions から Google Cloud への認証の仕組みを説明する動画つくって
```

この一言で、Claude が絵コンテと原稿を書きます。続けて、ナレーション（Gemini TTS）とテーマに合う BGM（Lyria）を作ります。最後に、[Claude **Motion**](https://support.claude.com/ja/articles/17454997-claude-motion%E3%82%92%E5%A7%8B%E3%82%81%E3%82%8B) でアニメーションを作り、手元の MP4 に書き出します。

> [!NOTE]
> Claude Motion はベータ版で、Team プランと Enterprise プランでのみ使えます（2026 年 10 月時点）。motion-render を使うには、どちらかのプランのアカウントが必要です。

## デモ動画

motion-render 自身が作った紹介動画です（59 秒、音声あり）。

https://github.com/user-attachments/assets/eb1bf7e6-a880-4bbe-b575-7f4ec5c21672

![motion-render の仕組み](docs/how-it-works.svg)

- 見た目・長さ・声・BGM の雰囲気はテーマから自動で決まります（指定すればそれに従います）
- 既存の Motion の動画の URL を渡して、ナレーションと BGM 付きの MP4 にすることもできます
- 描画用のブラウザ（Chromium）と ffmpeg は自動で用意されるので、環境ごとの差が出ません

## 必要なもの

| もの               | 備考                                                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | [Claude Motion](https://support.claude.com/ja/articles/17454997-claude-motion%E3%82%92%E5%A7%8B%E3%82%81%E3%82%8B) を使えるアカウント（ベータ版。Team・Enterprise プランのみ）。Claude Code 専用です（Codex・Cursor などには Motion がありません） |
| Node.js 22.18 以上 | `node -v` で確認。コマンドの TypeScript を Node がそのまま実行します                                                                                                                                                                               |
| Gemini API キー    | ナレーションと BGM に使います。Google AI Studio で発行します（[発行の手順](docs/api-key.ja.md)）                                                                                                                                                   |

macOS・Linux・Windows で動きます。

## インストール

### 1. 入れる

**推奨: プラグインとして入れる**。Claude Code の中で実行します。

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

**プラグインを使わない場合: skills CLI で入れる**

```sh
npx skills add umiyosh/motion-render -g
```

スキルだけが入るので、初回に Claude が `motion-render` コマンドを `npm install -g` で入れます。
sandbox などで入れられない環境では、プラグインとして入れてください。

### 2. API キーを設定する

Google AI Studio で Gemini API キーを発行します（[発行の手順](docs/api-key.ja.md)）。発行したキーをシェルの設定ファイル（`~/.zshrc` など）に足して、Claude Code を起動し直します。

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

| コマンド                                         | やること                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `motion-render narrate <work>`                   | `script.json` の原稿からナレーションを作り、場面の秒数を `timing.json` に書く    |
| `motion-render bgm <work>`                       | `script.json` の `bgm` の指示から BGM を作る                                     |
| `motion-render prepare <storeDir> <work>/film`   | Motion から取得した映像データを、描画できる形に展開する                          |
| `motion-render stills <filmDir> <outDir> 0,5,12` | 確認用の静止画を書き出す                                                         |
| `motion-render build <work> [out.mp4]`           | ナレーションと BGM を合成し、映像と合わせて MP4 にする（どちらかが無いと止まる） |
| `motion-render --version`                        | 版を表示する                                                                     |

| 環境変数                | 効果                                                         |
| ----------------------- | ------------------------------------------------------------ |
| `GEMINI_API_KEY`        | ナレーションと BGM の生成に必要                              |
| `MOTION_RENDER_OUT_DIR` | `build` の出力先を省略したときの保存先                       |
| `CHROMIUM_PATH`         | 同梱の Chromium の代わりに、手元の Chrome や Chromium を使う |
| `FFMPEG_PATH`           | 同梱の ffmpeg の代わりに、手元の ffmpeg を使う               |

## 困ったとき

| 症状                                                              | 原因と対処                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap_check_in ... Permission denied` でブラウザが起動しない | Claude Code の sandbox の中で動いています。インストールの手順 3 を確認してください。`motion-render` は単体で実行する必要があります（`\| grep` や `&&` でつなぐと sandbox の外に出ません）                     |
| `GEMINI_API_KEY is not set`                                       | インストールの手順 2 を確認し、Claude Code を起動し直してください                                                                                                                                             |
| ナレーションや BGM の生成が何度も失敗する                         | 1 回 90 秒で打ち切り、3 回まで再試行します。それでも失敗するなら、API キーの権限と利用上限を確認してください                                                                                                  |
| `motion-render` のインストールで ffmpeg のダウンロードが失敗する  | 社内プロキシなどで GitHub からの取得が止められています。`npm install -g --ignore-scripts <スキルのフォルダ>` で入れ、手元の ffmpeg を `FFMPEG_PATH` で指定してください（PATH 上の `ffmpeg` も自動で使います） |
| 初回の Chromium のダウンロードが失敗する                          | `CHROMIUM_PATH` に手元の Chrome か Chromium を指定してください                                                                                                                                                |
| `motion-render` の実行で `Unknown file extension ".ts"` が出る    | Node が 22.18 より古いです。Node を更新してください                                                                                                                                                           |
| 日本語の字形や改行位置が Motion のページと少し違う                | 文字は OS のフォントで描かれます                                                                                                                                                                              |

## 更新

プラグインとして入れた場合は、Claude Code の中で `/plugin` を開き、**Installed** で motion-render を選んで **Update now** を選びます。新しい版は Claude Code を起動し直すと読み込まれます。

Claude Code が自動で更新するのは、Anthropic 公式のマーケットプレイスだけです。motion-render の新しい版を毎回の操作なしで受け取るには、`/plugin` の **Marketplaces** で motion-render を選び、**Enable auto-update** を選びます。以後は Claude Code の起動時に更新されます。

シェルからは `claude plugin update motion-render@motion-render` で **Update now** と同じことができます。

skills CLI で入れた場合は、シェルで実行します。

```sh
npx skills update motion-render -g
```

## アンインストール

プラグインとして入れた場合は、Claude Code の中で実行します。

```
/plugin uninstall motion-render
```

skills CLI で入れた場合は、シェルで実行します。

```sh
npx skills remove motion-render -g
npm uninstall -g motion-render
```

ダウンロードした Chromium は Playwright のキャッシュ（macOS は `~/Library/Caches/ms-playwright`、Linux は `~/.cache/ms-playwright`）にあります。不要なら消してください。

## 安全性

- 描画中、動画のコードは外部への通信をすべて遮断され、映像データのフォルダの外のファイルも読めません
- Chromium 自身の sandbox を有効にして起動します（Playwright は既定で無効にするため、明示的に有効にしています）
- Claude Code の sandbox から外すのは `motion-render` コマンドだけです
- API キーは環境変数から読むだけで、ファイルや動画には残しません

## 開発

`npm install` の後、PR を出す前に `make check` を実行してください。CI と同じ検査（ESLint、Prettier、TypeScript の型検査、ユニットテストと描画のスモークテスト（カバレッジ 80% の基準つき）、品質ゲートのテスト、品質ベースラインの検査）をまとめて行います。スモークテストは `tests/fixtures` の Motion プレーヤーの代役を headless Chromium で開くので、API キーは要りません。

品質ベースラインには、今ある ESLint の警告と Knip の指摘が載っています。新しく増やしたり悪化させたりした PR は落ちます。直したら `make quality-baseline` で改善を記録してください（悪化は記録できません）。

## 構成

```
.claude-plugin/
  marketplace.json        # Claude Code のプラグイン一覧（このリポジトリ自身を載せる）
  plugin.json             # プラグインの名札
bin/motion-render         # プラグインが PATH に載せるコマンド（skills/motion-render の CLI を呼ぶ）
package.json              # プラグインの依存。Claude Code がプラグインを入れるときに自動で入れる。`npm run typecheck` で型を検査する
package-lock.json
tsconfig.json             # TypeScript の設定（型の検査用。実行時は Node が .ts をそのまま動かす）
skills/motion-render/     # スキル本体（skills CLI とプラグインの両方がここを読む）
  SKILL.md                # Claude が読む手順（準備、絵コンテ・原稿・BGM の決め方を含む）
  package.json            # motion-render コマンドと、依存の版（playwright-core, ffmpeg-static）
  scripts/cli.ts          # motion-render コマンド
  scripts/audio.ts        # ナレーションと BGM の生成、音声の合成
  scripts/work.ts         # script.json の検証と場面の秒数の計算
  scripts/render.ts       # ブラウザで描画する部分
  scripts/json.ts         # ファイル・API・プレーヤーから来る JSON を、形を確かめながら読む
  scripts/store.ts        # Motion の store を映像データのフォルダに展開する
docs/how-it-works.svg     # README の図
.github/workflows/ci.yml  # CI: 下の検査を PR ごとに実行する
Makefile                  # 開発用のコマンド（`make help` で一覧）
eslint.config.js, .prettierrc, knip.json
quality-baseline.json     # 返済対象の ESLint の警告と Knip の指摘。増えると CI が落ちる
scripts/quality-gate*.mjs # 今の指摘をベースラインと比べる
tests/                    # Vitest のユニットテストと描画のスモークテスト（フィクスチャの store と代役のプレーヤー）
vitest.config.ts          # テストの設定とカバレッジ 80% の基準
```
