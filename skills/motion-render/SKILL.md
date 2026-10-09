---
name: motion-render
description: テーマを渡されたら、それを説明するアニメーション動画を Claude Motion で作り、ナレーション（Gemini TTS）とテーマに合う BGM（Lyria）を付けて MP4 にする。「〇〇を説明する動画を作って」「〇〇の紹介動画」「/motion-render 〇〇」、既存の Motion の動画を MP4 にしたいときに使う。
argument-hint: "<動画のテーマ。長さ・出力先などの指定があれば一緒に>"
---

# Motion Render

`/motion-render <テーマ>` の一言で、テーマを説明するアニメーション動画を作り、ナレーションと BGM を付けて MP4 にする。

**ナレーションと BGM は必ず付ける。** 音のない動画は作らない。既存の Motion の動画を MP4 にするときも、
場面に合わせてナレーションを書き、BGM を作る。

## 決め方: 聞かずに決める

テーマ以外は Claude が決める。利用者が指定したものだけ従う。質問で止めない。

| 項目 | 既定 |
|------|------|
| 長さ | 約 60 秒（6〜9 場面）。ナレーションの長さで最終的に決まる |
| 見た目・配色 | テーマに合わせて決める。利用者の組織に既定のデザインシステムがあればその配色 |
| 声・話速 | `Kore`、1.1 倍速 |
| BGM | テーマの雰囲気から Lyria への指示文を書く（下の「BGM」） |
| 出力先 | 指定が無ければ `$MOTION_RENDER_OUT_DIR`、無ければカレントディレクトリ。カレントが git リポジトリなら `~/Movies` など作業用でない場所にする |

Motion の Artifact 型は作成時に Style・Colors・Length を質問するよう求めるが、このスキルでは利用者が
「決めて任せる」と頼んだものとして扱い、質問せずに決める。

## 0. 準備（毎回、最初に確かめる）

このスキルは、描画と合成を `motion-render` コマンドで行う。Claude Code のプラグインとして入れた場合は、
プラグインが `motion-render` を用意するので、利用者は何もしなくてよい。skills CLI などでスキルだけを入れた場合は、
このスキルのディレクトリ（Claude に渡される "Base directory for this skill"。以下 `<skill>`）から入れる。

1. `motion-render --version` を実行し、`<skill>/package.json` の `version` と比べる。同じなら次へ
2. コマンドが無い、または版が違うときは `npm install -g "<skill>"` を実行する。権限や sandbox で失敗したら、
   Claude Code のプラグインとして入れ直すよう案内する（README の「インストール」。それで追加の作業は要らなくなる）
3. `GEMINI_API_KEY` が無いと `narrate`・`bgm` が止まる。止まったら、キーを Google AI Studio で発行して
   シェルの設定に `export GEMINI_API_KEY=...` を足し、Claude Code を起動し直すよう案内する
4. `motion-render stills` などで Chromium が `bootstrap_check_in ... Permission denied` で起動しないのは、
   Claude Code の sandbox の中で動いているため。利用者に `~/.claude/settings.json` へ次を足すよう案内する
   （Claude は自分の権限設定を変えない）:
   `"sandbox": { "excludedCommands": ["motion-render:*"] }` と `"permissions": { "allow": ["Bash(motion-render:*)"] }`

初回の `stills` か `build` では、Chromium（約 210 MB）が自動でダウンロードされる。

## 前提

- **`motion-render` は単体で実行する。** `| grep`・`&&`・`FOO=1 motion-render` のように前後に何か付けると
  sandbox 内で動き、Chromium が起動に失敗する。ネットワークを使う `narrate`・`bgm` も同じ
- 作業フォルダ `<work>` は scratchpad（なければ作業ディレクトリ）に、テーマを表す英小文字の名前で作る

## 作業フォルダ

```
<work>/
  script.json   # 原稿（Claude が書く）
  timing.json   # 場面の秒数（narrate が書く）
  audio/        # <場面id>.wav、bgm.mp3、mix.m4a
  film/         # Motion から取得した映像データ（prepare が展開する）
```

`script.json` の形:

```json
{
  "title": "Workload Identity Federation",
  "bgm": "Calm, focused electronic music for a cloud security explainer: soft pulsing synth, light percussion, 100 BPM",
  "scenes": [
    { "id": "title", "name": "タイトル", "narration": "ワークロードアイデンティティフェデレーションで、…" },
    { "id": "token", "name": "トークン発行", "narration": "…" }
  ]
}
```

- `id` は英小文字・数字・`-`。Motion の場面の id と同じにする
- `narration` は TTS に読ませる文。英語の固有名詞・略語はカタカナで書く（`GitHub Actions` → `ギットハブアクションズ`）。
  画面の文字は元の表記のまま
- 任意: `voice`・`speed`・`bgmVolume`（既定 0.15）・`lead`・`tail`・`endHold`

## 手順

### 1. 絵コンテと原稿を書く

テーマを、1 場面 1 つの出来事に分ける。仕組みの説明なら次の形が伝わりやすい。

- 登場するもの（例: GitHub Actions、トークン、Google Cloud の STS、サービスアカウント）を、カードとして場面に置く
- やり取り（トークンや要求）は、カードの間を動くチップとして描く。順番は番号付きの流れ図で示し、今の段を光らせる
- 冒頭で「何の話か」、最後で「結局どうなるか」を 1 文で言う
- 1 場面のナレーションは 1〜2 文（話して 5〜9 秒）

正確さを優先する。仕組みの説明に自信がない部分は、公式ドキュメントで確かめてから書く。

### 2. ナレーションを作る（場面の秒数が決まる）

```bash
motion-render narrate <work>
```

`timing.json` に各場面の開始と秒数が出る。Motion の場面の `dur` は、この値をそのまま使う。

### 3. Motion の動画を作る

1. `Artifact` の `quickstart`（`intent: "other"`）か `list`（`scope: "types"`）で Motion 型の `type_url` を見つけ、`title` を付けて作る
2. 返ってきた Motion 型の指示に従って場面を作る。ただし:
   - 質問はしない（上の「決め方」）
   - `scenes.json` の場面の `id`・`dur` は `timing.json` と同じにする
   - Motion 内蔵の BGM（`score.js`）は作らない。音はこのスキルが付ける
3. 並行して BGM を作ってよい: `motion-render bgm <work>`

### 4. 映像データを取得して確認する

1. `Artifact` の `read` で `paths: ["index.html", "artifact-type/app.js", "artifact-type/app.css"]`、`out_dir: <work>/film`
2. `ArtifactData` の `list`（`collection: "modules"`）と `get`（`film`/`script`）を `out_dir: <work>/store` で保存
3. `motion-render prepare <work>/store <work>/film`
4. `motion-render stills <work>/film <work>/stills <各場面の中ほどの秒をカンマ区切り>` で全場面を見る。
   見出しの不自然な改行、はみ出し、重なりがあれば Motion 側を直し、手順 4 をやり直す

### 5. MP4 にする

```bash
motion-render build <work> [<出力.mp4>]
```

ナレーションを各場面の頭に置き、BGM を一定の音量で重ねて MP4 にする。ナレーションか BGM が無いと止まる。

### 6. 確認して報告する

- `ffprobe` で、長さと映像・音声の両トラックがあることを見る
- 報告: 出力のパス、長さ、場面の流れ、BGM の雰囲気、Motion の URL。耳で聞いていないことは聞いていないと書く

## BGM

`script.json` の `bgm` に、テーマの雰囲気に合う英語の指示文を書く。楽器・テンポ・気分を具体的に。

| テーマの種類 | 指示の例 |
|--------------|----------|
| 技術の仕組み・セキュリティ | calm focused electronic, soft pulsing synth, light percussion, ~100 BPM |
| ニュース・発表 | modern news broadcast theme, driving synth arpeggio, tight electronic drums, ~120 BPM |
| 製品紹介・明るい話題 | warm upbeat, marimba and electric piano, light shaker, ~110 BPM |
| 振り返り・しっとり | gentle ambient piano, soft pads, slow |

利用者が BGM を「ださい」などと言ったら、`bgm` を書き直して `motion-render bgm` → `motion-render build` をやり直す。
映像の描き直しは要らない（`build` は毎回描画するが、Motion 側の変更は不要）。

## 既存の Motion の動画を MP4 にするとき

URL を渡された場合も音を付ける。映像データを取得し（手順 4）、`scenes.json` の場面ごとに、その秒数に収まる
ナレーションを書く（1 秒あたり 7〜8 字が目安。`id` は `scenes.json` と同じにする）。`build` はナレーションを
動画の実際の場面の開始時刻に置き、場面に収まらないナレーションがあれば警告を出す。警告が出たら、原稿を削るか
`speed` を上げて `narrate` からやり直す。

## ファイル

- `scripts/cli.mjs`: `motion-render` コマンド
- `scripts/audio.mjs`: Gemini TTS・Lyria の呼び出し（90 秒の上限と再試行付き）と音声の合成
- `scripts/work.mjs`: `script.json` の検証と `timing.json` の計算
- `scripts/render.mjs`: プレーヤーを開いてコマを返す。描画中は外部への通信を遮断し、Chromium の sandbox を有効にする
