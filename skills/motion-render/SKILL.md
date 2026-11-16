---
name: motion-render
description: テーマを渡されたら、それを説明する平面の図解アニメ（カード・ラベル・番号付きの流れ）を HTML で作り、ナレーション（Gemini TTS）と一定の音量の BGM（Lyria）を付けて、質問も見直しも挟まずに 1 回の書き出しで MP4 にする。アニメーションに合わせた効果音（ElevenLabs）も付けられる。「〇〇を説明する動画を作って」「〇〇の紹介動画」「/motion-render 〇〇」、既存の Claude Motion の動画を MP4 にしたいときに使う。音ハメ・宣伝動画・凝った演出を頼まれたときは /motion-render:rich を使う。
argument-hint: "<動画のテーマ。長さ・出力先などの指定があれば一緒に>"
---

# Motion Render

`/motion-render <テーマ>` の一言で、テーマを説明する平面の図解アニメを作り、ナレーションと BGM を付けて MP4 にする。
1 つの仕組みを 1 分前後で説明する依頼を、約 10 分で仕上げる。

- **ナレーションと BGM は必ず付ける。** BGM は 1 曲を一定の小さな音量で敷く。効果音は `ELEVENLABS_API_KEY` があるときだけ付ける
- **しないこと**: 音ハメ（曲の候補・並べ替え・一打への反応）、three.js・モーションブラー・仕上げ（`look`）、
  書き出し前の `preview` と批評役の見直し、書き出し後の同期の測定
- 書き出しは 1 回だけ。`check` を `layout ok` まで直したら書き出し、報告する

利用者が音ハメ・宣伝動画・凝った演出を求めたら、このスキルではなく `/motion-render:rich` を使う。

## 決め方: 聞かずに決める

テーマ以外は Claude が決める。利用者が指定したものだけ従う。質問で止めない。

| 項目         | 既定                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 長さ         | 1 つの仕組みなら 60〜80 秒（6〜8 場面）。最終的にはナレーションの長さで決まる                                                              |
| 見た目・配色 | テーマに合わせて決める（html-film.md の「作風」）。利用者の組織に既定のデザインシステムがあればその配色                                    |
| 曲の作風     | 題材に合う実在のジャンルを毎回選ぶ（下の「BGM」）                                                                                          |
| 声・話速     | `Kore`、1.1 倍速                                                                                                                           |
| 出力先       | 指定が無ければ `$MOTION_RENDER_OUT_DIR`、無ければカレントディレクトリ。カレントが git リポジトリなら `~/Movies` など作業用でない場所にする |

## 0. 準備（毎回、最初に確かめる）

このスキルは、描画と合成を `motion-render` コマンドで行う。Claude Code のプラグインとして入れた場合は、
プラグインが `motion-render` を用意するので、利用者は何もしなくてよい。skills CLI などでスキルだけを入れた場合は、
このスキルのディレクトリ（Claude に渡される "Base directory for this skill"。以下 `<skill>`）から入れる。

1. `motion-render --version` を実行し、`<skill>/package.json` の `version` と比べる。同じなら次へ
2. コマンドが無い、または版が違うときは `npm install -g "<skill>"` を実行する。権限や sandbox で失敗したら、
   Claude Code のプラグインとして入れ直すよう案内する（README の「インストール」。それで追加の作業は要らなくなる）。
   `Unknown file extension ".ts"` で止まるのは Node が 22.18 より古いため。Node の更新を案内する
3. `GEMINI_API_KEY` が無いと `narrate`・`bgm` が止まる。止まったら、キーを Google AI Studio で発行して
   シェルの設定に `export GEMINI_API_KEY=...` を足し、Claude Code を起動し直すよう案内する。
   `test -n "$ELEVENLABS_API_KEY" && echo set` で効果音のキーの有無も見ておく（無ければ効果音を付けずに進める）
4. `motion-render stills` などで Chromium が `bootstrap_check_in ... Permission denied` で起動しないのは、
   Claude Code の sandbox の中で動いているため。利用者に `~/.claude/settings.json` へ次を足すよう案内する
   （Claude は自分の権限設定を変えない）:
   `"sandbox": { "excludedCommands": ["motion-render:*"] }` と `"permissions": { "allow": ["Bash(motion-render:*)"] }`

初回の `stills` か `build` では、Chromium（約 210 MB）が自動でダウンロードされる。

## 前提

- **`motion-render` は単体で実行する。** `| grep`・`&&`・`FOO=1 motion-render` のように前後に何か付けると
  sandbox 内で動き、Chromium が起動に失敗する。ネットワークを使う `narrate`・`bgm`・`sfx` も同じ
- 作業フォルダ `<work>` は scratchpad（なければ作業ディレクトリ）に、テーマを表す英小文字の名前で作る

## 作業フォルダ

```
<work>/
  script.json   # 原稿と BGM の指示文（Claude が書く）
  timing.json   # 場面の秒数（narrate が書く）
  words.json    # 語りの文字ごとの秒（narrate が書く）
  steps.jsonl   # 各コマンドの開始と終了（motion-render times で表にする）
  audio/        # <場面id>.wav、bgm.mp3、mix.m4a、sfx/
  film/         # html の映像（kit が用意し、Claude が index.html を書く）
```

`script.json` の形:

```json
{
  "title": "<題>",
  "bgm": "<英語の 1〜2 文の指示文。下の「BGM」>",
  "scenes": [
    { "id": "title", "name": "<場面の名前>", "narration": "<語り>" },
    { "id": "token", "name": "<場面の名前>", "narration": "<語り>" }
  ]
}
```

- **`bpm`・`section`・`score` は書かない。** これらがあると、コマンドが音ハメの流れ（`/motion-render:rich` の、曲の候補 4 本と並べ替え）で動く
- `id` は英小文字・数字・`-`。`bgm`・`score`・`mix`・`hits`・`sfx` は使えない
- `narration` は TTS に読ませる文。英語の固有名詞・略語はカタカナで書く（`GitHub Actions` → `ギットハブアクションズ`）。画面の文字は元の表記のまま
- 任意: `voice`（既定 `Kore`）・`speed`（既定 1.1）・`bgmVolume`（既定 0.15）・`sfxVolume`・`lead`・`tail`・`endHold`、場面ごとの `sfx`（下の「効果音」）。既定のままなら書かない

## 手順

### 1. 原稿を書く

テーマを、1 場面 1 つの出来事に分ける。冒頭で「何の話か」、最後で「結局どうなるか」を 1 文で言う。
1 場面のナレーションは 1〜2 文（話して 5〜8 秒）。正確さを優先し、自信がない部分は公式ドキュメントで確かめる。

### 2. ナレーションを作る（場面の秒数が決まる）

```bash
motion-render narrate <work>
```

`timing.json` に各場面の開始と秒数が出る。`<work>/words.json` には、場面ごとの語りの文（`text`）と、その 1 文字ずつの声の [開始, 終了]（`chars`）が入る。
`chars` の秒は音声ファイルの頭からの秒で、場面の頭からの秒は `lead`（既定 0.25）＋ その秒 ÷ `speed`（既定 1.1）になる。
映像では `film.word(場面, "語")` がこの換算をした秒を返すので、映像の中では words.json を読まない。

### 3. 道具を置き、曲を裏で作る

```bash
motion-render kit <work>
motion-render bgm <work>
```

`kit` で `<work>/film/` にプレーヤー・部品・フォント・GSAP・場面の秒数が置かれる。`bgm` は Bash の `run_in_background` で裏に回す
（1〜2 分）。`bgm` が失敗したら（`no audio in the response` など）、同じ指示文で 1 回やり直し、それでも失敗したら指示文を書き直す。

### 4. 映像を書く

`<skill>/references/html-film.md` のうち、次の節だけを読む: 「ページの骨組み」「作る前に決めること」「作風」「部品」「配置の決まり」「確認」「動き」「文字」「決まった絵になるように」「効果音」。
それらの節にある拍・曲・山場・演出・音ハメ・`film.draw`・`kit/beat.js` に触れた行は、このスキルでは当てはまらない。ほかの節は読まない。

- 「作る前に決めること」は、作風と配色・文字の役割・動きの性格の 3 つだけを書く（最初の項目は読まない節のもの）
- 「ページの骨組み」はそのまま写してよい。`kit/beat.js` の読み込みは残しても外してもよく、`<!-- scenes -->` の行は要らない
- 画面は 1920×1080。安全域は左右 144px、上下 81px

`<work>/film/index.html` 1 枚に、全場面を `<section class="scene" id="<場面id>">` として書く（`scenes/` には分けない）。
plan.md は書かない。各場面の動きの秒は、語りの語の秒（`film.word`）と場面の長さから、書きながら決める。
仕組みの説明は次の形が伝わりやすい。

- 登場するもの（サービス、人、データの置き場）を、カードとして場面に置く
- やり取り（トークン、要求、データ）は、カードの間を動くチップとして描く（`film.spot`・`film.arc`）
- 順番は番号付きの流れ図（部品の「工程の列」）で示し、今の段を `film.light` で光らせる
- 次の場面でも使う物は `#stage` に置き、場面の頭で新しい位置へ動かしてつなぐ
- 語りの要の語は `film.say`・`film.mark` で、言った瞬間に出す・強調する

秒は `film.at`・`film.end`・`film.word` だけで書く。`check` で止められやすい書き方は、最初から避ける。

- 1 つのチップの出る・動く・消えるは、値ごとに 1 本の動きにまとめる（不透明度は `keyframes` で 1 本、位置は `fromTo` で 1 本）。
  出発点はタイムラインの外で `gsap.set(チップ, film.spot(チップ, 出発点))` と決める。同じ値を 2 本の動きで書くと、巻き戻しで絵が変わる
- まだ見せない物は `opacity: 0` で隠す。`clip-path` で隠した物は、`check` が見えている物として数える
- `film.say`・`film.typeIn` は文字だけを持つ要素に使う（子要素があるとエラーで止まる）
- `film.say` の `slam` のように文字を一時的に大きくする動きは、40px 以上の見出しだけに使う。小さな文字に使うと、`check` が大きな文字の短い表示として止める
- 字幕は要る場面だけに付ける

効果音を付けるときは、映像を書き終えてから、効果音を鳴らす動きの秒を `script.json` の `sfx` に書き、`motion-render sfx <work>` を裏で始める
（確認の間に終わる）。`at` は、その動きに渡した `film.at(場面, 秒)` の秒にする。`film.say`・`film.mark` の動きなら、その語の最初の文字の `chars` の開始秒を、手順 2 の式で場面の頭からの秒に直した値にする。

### 5. 確認する

```bash
motion-render check <work>/film
motion-render stills <work>/film <work>/stills <各場面の中ほどの秒をカンマ区切り>
```

`check` を `layout ok` まで直す（出力の読み方は html-film.md の「確認」の最初の表）。静止画は全場面を 1 回見て、
見出しの不自然な改行、はみ出し、重なり、カードの枠線をまたいで止まったチップ、読めない文字があれば直す（枠線をまたいだチップは `check` が見逃すことがある）。
直したら `check` をやり直し、直した場面の秒だけ静止画を見直す。`stills` の秒は動画の頭からの秒。効果音があれば、同じ `stills` で各効果音の秒（timing.json の場面の `start` ＋ `at`）も書き出し、
鳴らす対象がその時点で画面に出ているかを見る。

### 6. MP4 にする

```bash
motion-render build <work> [<出力.mp4>]
```

ナレーションを各場面の頭に置き、BGM を一定の音量で重ね（短ければつないで延ばし、最後の 3 秒でフェードする）、30fps で書き出す。
`warning:` で語りが場面に収まらないと出たら、原稿を削るか `speed` を上げて `narrate` からやり直す。

### 7. 報告する

- `ffprobe` で、長さと映像・音声の両トラックがあることを見る
- 報告: 出力のパス、長さ、場面の流れ、BGM の作風、`<work>/film/index.html` のパス、
  かかった時間（`motion-render times <work>` の最後の行）。耳で聞いていないことは聞いていないと書く

## BGM

`script.json` の `bgm` に、英語の 1〜2 文で書く。曲は語りの下に一定の小さな音量で敷くだけなので、指示文も短くてよい。

- 題材の速さと温度に合う**実在のジャンルを 1 つ選び**、下位ジャンル・時代まで絞って書く。ジャンルを書かずに気分だけを書くと、
  どの音楽にも属さない無機質な曲になる。前に作った動画と同じジャンルを選ばない
- そのジャンルを特徴づける楽器と、速さ（BPM）を添える。歌は入れない（語りとぶつかる）
- 例の形: `Instrumental <ジャンル>: <楽器と奏法>, around <n> BPM, steady and unobtrusive under a voice-over.`

利用者が曲を「ださい」などと言ったら、`bgm` を書き直して `motion-render bgm` → `motion-render build` をやり直す（映像は直さない）。

## 効果音

`ELEVENLABS_API_KEY` があるときだけ付ける。無ければ付けずに進め、報告で「効果音はキーが無いので付けていない」と書く。

- 画面で目に見える出来事（カードが出る、チップが着く、段が光る、拒否される）にだけ、柔らかく短い音（0.5〜1.5 秒）を置く。音は語りより前に出ないこと
- `script.json` の場面ごとの `sfx` に、`at`（秒の決め方は手順 4 の終わり）・`prompt`（英語）・`duration`（0.5〜10 秒）を書く。
  同じ種類の出来事には同じ `prompt` と `duration` を使う（音がそろい、同じ音は 1 回しか作られない）
- `build` は、効果音ごとに音量をナレーションの平均より 4 dB 下にそろえ、`duration` で切り、両端をフェードしてから混ぜる
- 報告には試聴用の `audio/sfx/preview.m4a` のパスと順番を書き、合わない音があれば教えてほしいと添える。答えは待たずに終える

**表記**: 月額プランなしで作った効果音は、商用に使えず、公開するときは題名に `elevenlabs.io` か `11.ai` を入れる
（ElevenLabs のヘルプ「Can I publish the content I generate on the platform?」）。効果音を付けた動画では、
タイトルの場面に `SFX: 11.ai` を小さく入れる。利用者が月額プランに入っていると言った場合は省いてよい。

## Claude Motion で作るとき

利用者が Claude Motion を指定したときと、既存の Motion の動画の URL を渡されたときに使う。曲は手順 3 と同じ 1 曲にする。

1. 新しく作るときは、`Artifact` の `quickstart`（`intent: "other"`）か `list`（`scope: "types"`）で Motion 型を探し、`type_url` に `title` を付けて作る。
   返ってきた Motion 型の指示に従って場面を作る。質問はしない。`scenes.json` の場面の `id`・`dur` は `timing.json` と同じにする。
   Motion 内蔵の BGM（`score.js`）は作らない
2. 既存の動画のときは、`scenes.json` の場面ごとに、その秒数に収まるナレーションを書く（1 秒あたり 7〜8 字が目安。`id` は `scenes.json` と同じにする）
3. 映像データを取得して MP4 にする:
   1. `Artifact` の `read` で `paths: ["index.html", "artifact-type/app.js", "artifact-type/app.css"]`、`out_dir: <work>/film`
   2. `ArtifactData` の `list`（`collection: "modules"`）と `get`（`film`/`script`）を `out_dir: <work>/store` で保存
   3. `motion-render prepare <work>/store <work>/film`
   4. `motion-render stills` で全場面を見てから `motion-render build <work>`

`build` はナレーションを動画の実際の場面の開始時刻に置き、場面に収まらないナレーションがあれば警告を出す。
警告が出たら、原稿を削るか `speed` を上げて `narrate` からやり直す。

## ファイル

- `scripts/cli.ts`・`scripts/beatcli.ts`: `motion-render` コマンド（TypeScript。Node 22.18 以上がそのまま実行する）
- `scripts/audio.ts`: Gemini TTS・Lyria の呼び出し（90 秒の上限と再試行付き）、曲の候補、音声の合成
- `scripts/score.ts`: 曲の候補を小節ごとに測った表、選んだ小節の並べ替えと書き出し、山場の点検（`score`。`/motion-render:rich` が使う）
- `scripts/signal.ts`・`scripts/tempo.ts`・`scripts/hits.ts`: 音の読み込み、テンポと小節の頭、16 分音符ごとの打音の検出
- `scripts/sync.ts`: 語り・山場・一打の同期を、MP4 か、必要なコマだけを描いて測る（`sync`・`preview`）
- `scripts/sfx.ts`: ElevenLabs による効果音の生成（`sfx`）、音量の測定とそろえ方、試聴用ファイル
- `scripts/work.ts`: `script.json` の検証、`timing.json` の計算、ナレーションを場面の開始時刻に置く処理
- `scripts/render.ts`: プレーヤーを開いてコマを返す。描画中は外部への通信を遮断し、Chromium の sandbox を有効にする
- `scripts/kit.ts`・`kit/`: html の映像のプレーヤー（`player.js`）、音ハメの部品（`beat.js`）、土台・作風・部品の CSS を、フォントと GSAP と一緒に置く（`kit`）
- `scripts/scenes.ts`: `film/scenes/*.html` を index.html の `<!-- scenes -->` に差し込んで、描画するページにする
- `scripts/layout.ts`・`scripts/snapshot.js`・`scripts/repeat.ts`: html の映像の確認（配置、短すぎる文字、巻き戻しで変わる絵。`check`。`stills`・`build` も実行する）
- `scripts/steps.ts`: 各コマンドの開始と終了を `<work>/steps.jsonl` に残し、工程ごとの時間の表にする（`times`）
- `references/html-film.md`: html の映像の書き方、音ハメの演出と書き方、配置の決まり、部品、場面を分けて書くときの決まり
- `references/pipeline.md`: `/motion-render:rich` の工程のつながり（何を待ち、何を裏で動かすか）と、工程を足すときの決まり
- `scripts/json.ts`: ファイル・API・プレーヤーから来る JSON を、形を確かめながら読む
- `scripts/store.ts`: Motion の store（ArtifactData の保存先）を映像データのフォルダに展開する（`prepare`）
