---
name: motion-render
description: テーマを渡されたら、それを説明するアニメーション動画を HTML（利用者が指定すれば Claude Motion）で作り、ナレーション（Gemini TTS）と、映像の山場に合わせて組み立てた BGM（Lyria）を付け、場面の動きを拍に乗せ、山場ではドラムの一打ごとに映像が応える音ハメを入れて MP4 にする。アニメーションに合わせた効果音（ElevenLabs）も付けられる。「〇〇を説明する動画を作って」「〇〇の紹介動画」「/motion-render 〇〇」、既存の Motion の動画を MP4 にしたいときに使う。
argument-hint: "<動画のテーマ。長さ・出力先などの指定があれば一緒に>"
---

# Motion Render

`/motion-render <テーマ>` の一言で、テーマを説明するアニメーション動画を作り、ナレーションと BGM を付けて MP4 にする。

**ナレーションと BGM は必ず付ける。** 音のない動画は作らない。効果音は `ELEVENLABS_API_KEY` があるときだけ付ける（下の「効果音」）。

**音ハメを当たり前の品質にする。** 新しく作る動画は、次の順に時間を決める。

1. **語り**が時間を決める。語りは途切れさせない（場面の間は 1 小節以内）
2. **映像**は語りに合わせて山場を作る。山場では、多少過剰に感じても下の演出を全部入れる。
   山場の外では、場面の動き（出る、着く、引かれる）を拍と一打の時刻に置くだけにし、理由の無い物を一打で跳ねさせない
3. **曲**はその山場に合わせて組み立てる。Lyria に「各時刻に画面で何が起き、曲がどうするか」を渡し、返ってきた生の演奏を
   小節単位で並べ替えて山場に合わせる。ドラムは打ち込まない。曲から一打ずつ検出し、全開ではキックに映像の動力を応えさせる

一打ごとの反応は html の映像でしか書けないので、新しく作る動画は html の映像で作る。
Claude Motion を使うのは、利用者が Motion を指定したときと、既存の Motion の動画を MP4 にするときだけ（下の「Motion で作るとき」）。

## 決め方: 聞かずに決める

テーマ以外は Claude が決める。利用者が指定したものだけ従う。質問で止めない。

| 項目           | 既定                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 長さ           | テーマの中身から決める。上限はない。1 つの仕組みなら 60〜90 秒（8〜11 場面）、段階や比較が多いテーマは数分。最終的にはナレーションの長さで決まる |
| 曲の作風・速さ | テーマから下の「曲の作風」の表で決める                                                                                                           |
| 見た目・配色   | テーマに合わせて決める（references/html-film.md の「作風」）。利用者の組織に既定のデザインシステムがあればその配色                               |
| 声・話速       | `Kore`、1.1 倍速                                                                                                                                 |
| 出力先         | 指定が無ければ `$MOTION_RENDER_OUT_DIR`、無ければカレントディレクトリ。カレントが git リポジトリなら `~/Movies` など作業用でない場所にする       |

長さを 60 秒に収めるために説明を削らない。2 分を超える動画になるときは、書き出しに動画 1 分あたり 2〜3 分ほどかかることを
最初に一言伝えてから、止めずに進める。

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
  sandbox 内で動き、Chromium が起動に失敗する。ネットワークを使う `narrate`・`bgm` も同じ
- 作業フォルダ `<work>` は scratchpad（なければ作業ディレクトリ）に、テーマを表す英小文字の名前で作る

## 作業フォルダ

```
<work>/
  script.json   # 原稿と、区間の印と、曲の並べ方（Claude が書く）
  timing.json   # 場面の秒数。拍と小節にそろえてある（narrate が書く）
  plan.md       # 絵コンテ、山場の演出、秒の計画（Claude が書く）
  score.txt     # Lyria への指示文: 各時刻に画面で何が起き、曲がどうするか（Claude が書く）
  steps.jsonl   # 各コマンドの開始と終了（コマンドが書く。motion-render times で表にする）
  audio/        # <場面id>.wav、bgm/（候補 take1〜4 と小節表 takes.txt）、score.wav（並べた曲）、
                # hits.json（曲の一打の一覧）、mix.m4a、sfx/
  film/         # html の映像（kit が用意し、Claude が index.html と scenes/*.html を書く）
```

`script.json` の形:

```json
{
  "title": "ロケットが宇宙へ届くまで",
  "bgm": "jazzy drum and bass, 172 BPM",
  "bpm": 172,
  "scenes": [
    { "id": "title", "name": "タイトル", "narration": "ロケットは、どうやって宇宙へ届くのか。…", "section": "intro" },
    { "id": "count", "name": "最終確認", "narration": "発射の 1 分前。…", "section": "build" },
    { "id": "ignite", "name": "点火", "narration": "3 秒前、9 基のエンジンが点火。…" },
    { "id": "liftoff", "name": "リフトオフ", "narration": "リフトオフ。…", "section": "drop" }
  ],
  "score": { "take": 3, "bars": "0-11,12-18,20-29,35-42,-1" }
}
```

- `id` は英小文字・数字・`-`。`narration` は TTS に読ませる文。英語の固有名詞・略語はカタカナで書く
  （`GitHub Actions` → `ギットハブアクションズ`）。画面の文字は元の表記のまま
- `bpm` は曲の速さ（下の「曲の作風」）。これがあると、場面の頭が拍に、`section` のある場面の頭が小節の頭にそろう
- `section` はその場面から始まる曲の区間: `intro`（入り）・`build`（溜め）・`drop`（全開）・`break`（音を大きく減らす。無音にはしない）・`groove`（落ち着いた刻み）・`outro`（終わり）
- `score` は、曲の候補のどれを使い、映像の小節ごとにその候補のどの小節を鳴らすか（手順 6）
- 任意: `voice`・`speed`・`scoreLevel`（曲の大きな小節の、ナレーションに対する音量。既定 +4.1 dB）・`sfxVolume`・`lead`・`tail`・`endHold`、
  場面ごとの `sfx`（下の「効果音」）

## 手順

待ち時間を作らない順に進める。API を待つ工程（曲の候補・効果音）は Bash の `run_in_background` で裏に回し、
その間に Claude は書き続ける（工程のつながりは [references/pipeline.md](references/pipeline.md)）。

### 1. 原稿と山場を決める

テーマを、1 場面 1 つの出来事に分ける。冒頭で「何の話か」、最後で「結局どうなるか」を 1 文で言う。
1 場面のナレーションは 1〜2 文（話して 4〜8 秒）。正確さを優先し、自信がない部分は公式ドキュメントで確かめる。

続けて、話の盛り上がりから曲の区間を決め、場面に `section` を付ける。曲の起伏は話の起伏に従わせる。
決まった型（溜め → 止め → 全開を 2 回）に話を当てはめない。

- **全開（`drop`）は 1〜2 回**（2 分を超えるなら 3 回まで）。話が動く場面に置く: 答えが出る、仕組みが動き出す、
  限界を越える。2 回置くなら 2 回目を大きくする
- **曲を止めるのは 1 本に 1 回まで。** 止める理由が話の中にある所にだけ置く: 秒読みの 0、エンジンが止まる、
  ぶつかる直前、問いを投げて答えを待つ瞬間。止めるのは 1 小節までにし、次の小節で全開に入る。
  止めを繰り返すと、曲が何度も切れたように聞こえ、止めの意味が薄れる（`score` が 2 回目から止める）
- 止めを置かない全開は、溜め（`build`）から途切れずに上がって入る: 刻みが細かくなり、音が厚くなり、そのまま全開になる
- 全開と全開の間は落ち着いた区間（`groove`）にする。刻みを残したまま音を減らし、次の溜めにつなぐ。
  `break`（音を大きく減らす区間）は、話に理由があるときだけ 1 回置く。無音にはしない
- 最初の場面は `intro`、最後の 1〜2 場面は `outro` か `groove`。最後の語りの後の小節の頭に「最後の一打」が来る（自動）
- 区間は場面の頭にしか置けない。区間のない場面は前の区間を続ける

### 2. ナレーションを作る（場面の秒数が決まる）

```bash
motion-render narrate <work>
```

`bpm` があると、場面の開始・小節の位置・区間・最後の一打・映像の小節の数を表で出す。この表の時刻で曲の指示文と映像を書く。

### 3. 映像の計画を書く

[references/html-film.md](references/html-film.md) を読む（特に「音ハメ」の節）。`motion-render kit <work>` で
`<work>/film/` にプレーヤー・部品・フォント・GSAP・場面の秒数を置き、`<work>/plan.md` を書く。

- 場面ごとに、見せるもの、使う部品、動きとその秒、場面をまたいで残る物の状態（html-film.md の「絵コンテと秒の計画」）
- 曲の区間ごとに、html-film.md の「必ず入れる演出」の表のどれをどの物で見せるか。まず全開でキックに応える
  「動力」を 1 つ決める。一打で動く理由がその物にあること（例: ロケットならエンジンの炎、工場ならプレス、通信なら送信機のランプ）
- 一打で動かさない物も決める: 自分の拍を持つ物（心臓、時計、歩み）、文字、背景

### 4. 曲の指示文を書き、候補を作る

`<work>/score.txt` に Lyria への指示文を書き（下の「曲」）、候補作りを裏で始める。

```bash
motion-render bgm <work>
```

4 本の候補を同時に作り、それぞれを小節ごとに測った表を出す（1〜2 分。`audio/bgm/takes.txt` にも残る）。

### 5. 映像を書く

待つ間に `<work>/film/index.html` を書く。音ハメの動き（一打の反応、カメラ、閃光、揺れ、大きな文字、計器）は
`film.draw` と `kit/beat.js` で、時刻だけから描く（html-film.md の「音ハメ」）。曲の一打の一覧は手順 6 の後に
`kit/timing.js` に入るので、映像はその前に書いてよい。

場面が多く Agent ツールがあれば、場面ごとの図の出し入れは html-film.md の「場面を分けて書く」で手分けしてよい。
音ハメの層（index.html の `film.draw`）は手分けせず、Claude が 1 つに書く。

### 6. 曲を映像の小節に並べる

候補の表が出たら、候補を 1 つ選び、映像の小節ごとに鳴らす候補の小節を `script.json` の `score` に書く（下の「曲」の
「候補と小節の選び方」）。続けて実行する。

```bash
motion-render score <work>
```

選んだ小節を映像の速さに合わせて並べ（`audio/score.wav`）、その曲から一打ずつ検出して `audio/hits.json` と
`film/kit/timing.js` に書く。映像の小節ごとの表と、山場の点検（`check:` の行）を出す。
`check:` の行が無くなるまで `score` の並びを直して、`score` をやり直す（数秒）。

### 7. 確認する

```bash
motion-render check <work>/film
motion-render stills <work>/film <work>/stills <秒をカンマ区切り>
```

- `check` は配置に加え、短すぎる文字（大きな文字が 2 秒未満で消える）と、巻き戻しで変わる絵を止める。`layout ok` まで直す
- 静止画は、各場面の中ほどと、全開の 1 拍前・全開の瞬間・その 1 拍後・最後の一打を見る。文字が読めるか、
  物が画面の外に出ていないか、地面と物の位置が合っているかを見る

### 8. MP4 にする

```bash
motion-render build <work> [<出力.mp4>]
```

ナレーションを各場面の頭に置き、並べた曲をナレーションに対する音量（`scoreLevel`）で重ね、60fps で書き出す。
書き出した後、MP4 そのもので同期を測って `sync:` の行に出す。

- 語り: 声の割合と、一番長い間
- 山場: 全開と最後の一打で、画面全体がその瞬間に大きく変わるか（ずれの ms）
- 一打: 全開の区間で、キックのたびに画面が動くか（打音の無い 8 分音符後と比べる）。スネアは測って出すだけ

`sync: ok` になるまで映像を直して書き出し直す。`sync problem:` の直し方は html-film.md の「確認」。
`motion-render sync <work> <mp4>` で測り直せる。

### 9. 報告する

- `ffprobe` で、長さと映像・音声の両トラックがあることを見る
- 報告: 出力のパス、長さ、場面の流れ、曲の作風と区間（どこで全開になるか）、`sync:` の行、
  `<work>/film/index.html` のパス、かかった時間（`motion-render times <work>` の最後の行）。耳で聞いていないことは聞いていないと書く

## 曲

### 曲の作風

生のドラムが入った作風にする（一打を検出して映像を動かすため）。テーマで選ぶ。

| テーマの種類                       | 作風（score.txt に書く言葉）                                                   | 速さ     |
| ---------------------------------- | ------------------------------------------------------------------------------ | -------- |
| 乗り物・宇宙・速さ・競争           | late-night jazz-flavoured drum and bass, live jazz breakbeat, Rhodes, sub bass | 170〜174 |
| ソフトウェア・仕組み・データ・道具 | late-90s big beat, live funk breakbeat, filtered bass riff, guitar stabs       | 126〜136 |
| 科学・自然・歴史・物語             | cinematic breakbeat, live drums, strings and piano                             | 110〜120 |
| 製品・明るい話題・暮らし           | funk with a live drum kit, slap bass, clavinet, horns                          | 112〜122 |
| 振り返り・しっとり・人の話         | liquid drum and bass, half-time feel, soft Rhodes and pads                     | 170〜174 |

EDM の上昇音、うねるベース、きらびやかなシンセの壁、歌は使わない（騒がしく安っぽくなる）。
速さは 100 未満にしない。1 小節が長いと、区間の頭を小節にそろえたときに語りの間が延びる。

### 指示文（score.txt）の書き方

演出の意図そのものを書く。曲の説明だけでなく、各時刻に画面で何が起き、曲がそのときどうするかを書く。
時刻は narrate の表から写す（`m:ss.s`）。次の形にする。

```
Score for a 91-second animated film about a rocket launch, from the final countdown to reaching orbit.
Write it as real music that follows the picture exactly: instrumental late-night jazz-flavoured drum and bass
at exactly 172 BPM in 4/4, steady tempo throughout. Warm Rhodes electric piano with jazz chords, a deep sub
bass and an upright bass, and a real, crisp, live-sounding jazz breakbeat with ghost notes, a hard snare on
beats 2 and 4, rolling 16th-note hi-hats, rides and crash cymbals. Cool and cinematic, never cheesy: no EDM
risers, no wobble bass, no supersaw, no vocals.

What happens on screen, and what the music does at each moment:

[0:00 - 0:08] Title. A rocket stands on the pad at night. Rhodes chords and a soft sub only, no drums. Intensity: 2/10
[0:08 - 0:17] The final checks. A clock ticks: a closed hi-hat in 8th notes enters alone. Tension rises slowly. Intensity: 3/10
[0:17 - 0:26] The nine engines ignite one after another, then thrust builds. Heavy kick hits come in, then a snare
roll builds from quarter notes to 8ths to 16ths, getting louder and faster. At 0:25.1 everything cuts to complete
silence for one bar. Intensity: 6/10 rising to 9/10
[0:26 - 0:40] LIFTOFF at exactly 0:26.5: the full band and the breakbeat slam in on the downbeat with a crash cymbal.
Driving rolling groove. Intensity: 9/10
[0:48 - 0:56] The first stage burns out and falls away. The band drops back to bass, Rhodes and a soft hi-hat pulse,
sparse but still moving, never silent. From 0:53.0 the drums build back bar by bar, kicks and snares getting
busier and louder, rising straight into the next drop with no gap. Intensity: 4/10 rising to 8/10
[0:56 - 1:13] At exactly 0:55.8 the second drop comes straight out of that build: the full breakbeat, even harder
and busier. Intensity: 10/10
[1:28 - 1:31] At 1:27.9 one final hit on the downbeat with a crash, then let it ring out to silence. Intensity: 3/10
```

- 1 行目に、長さ・題材・作風・速さ（exactly ○ BPM in 4/4, steady tempo）・楽器（real, live-sounding drums）・避けるものを書く
- 区間ごとに 1 行。「画面で起きること」「曲がすること」「Intensity: n/10」を書く
- 山場は秒まで書き、言葉を強くする: 全開は `slam in on the downbeat at exactly m:ss.s with a crash`、
  最後は `one final hit on the downbeat at m:ss.s, then let it ring out to silence`
- `cuts to complete silence for one bar at m:ss.s` と書くのは、1 本に 1 回の止めだけ。ほかの全開の前は
  `rising straight into the drop with no gap` と書く
- 落ち着いた区間（`groove`・`break`）は `sparse but still moving, never silent` と書き、刻みを残させる

### 候補と小節の選び方

`motion-render bgm` の表は、候補ごとに 1 小節 1 行で、時刻・大きさ（その曲の大きな小節に対する dB）・
キック（K）・スネア（S）・ハイハット（H）の数・16 分音符の並び（`K` キック、`S` スネア、`X` 両方、`g` ゴースト、`-` ハイハット）・
目印（`quiet` 静か、`no drums` ドラム無し、`drums`、`full` 全開。`▲` `▼` は前の小節から 6 dB 以上の増減）を出す。
Lyria は区間を 4・8 小節に丸め、0〜4 小節ずらし、ときに抜かすので、この表を見て並べ直す。

`score` の `bars` には、映像の小節 0 から順に、その小節で鳴らす候補の小節を書く。`0-11` は範囲、`-1` は無音の小節。
映像の小節の数は narrate の表の最後の行にある。

1. **候補を選ぶ。** 指示した山場がそろっている候補にする: `full` の小節（全開の頭）、止めを指示した所の `quiet` か
   `no drums` の小節、終わり近くの「1 拍目に一打があり、次の小節から静かになる」小節（最後の一打）。
   速さの調整（表の 1 行目の「played ○% faster」）が 5% を超える候補は避ける
2. **区間ごとに割り当てる。** narrate の表の各区間の頭の小節に、その区間に合う候補の小節が来るようにする
   - `drop`: `full` の小節（`▲` があればそれ）を区間の頭に置き、続く `full` の小節を順に並べる
   - 止め（1 本に 1 回）: その全開の直前の 1 小節に、候補の `quiet` か `no drums` の小節を置く
   - 止めを置かない全開の直前: 大きさが上がっていく `drums` の小節（候補の、全開の 1 小節前の小節が一番つながる）
   - `build`: `drums` で大きさが上がっていく小節、または刻みが細かくなる小節
   - `groove`・`break`: 刻みの残る静かな `drums` の小節（`▼` の付いたものでよい）。`no drums` を続けない
   - `intro`・`outro`: `no drums` か、静かな `drums` の小節
   - 最後の一打の小節: 1 拍目に `K` か `X` があり、次から静かになる小節。そのあとは余韻の小節か `-1`
3. **区間の中は候補の小節を続けて並べる。** つなぎ目は区間の境目にだけ作る。同じ小節を 3 回以上続けない。
   `-1`（無音の小節）は最後の一打の後にだけ使う。曲の途中の無音は、演奏の止めより不自然に聞こえる
4. `motion-render score <work>` の `check:` の行が無くなるまで直す。`the music stops dead N times` が出たら、
   止めを 1 つ残し、ほかの止めの小節を大きさが上がっていく `drums` の小節に替える。どの候補でも山場がそろわないときは、
   score.txt の山場の言葉を強めて `bgm` をやり直す（2 回まで）

利用者が曲を「ださい」などと言ったら、score.txt の作風を書き直して `bgm` から `score`・`build` をやり直す。
映像の書き直しは要らない（一打の一覧は `score` と `build` が書き直す）。

## 効果音

`ELEVENLABS_API_KEY` があるときだけ付ける。無ければ付けずに進め、報告で「効果音はキーが無いので付けていない」と書く。
山場とドラムの一打は曲が鳴らすので、効果音はそれ以外の出来事（カードが出る、チップが着く、チェックが付く）にだけ付ける。

置き方:

- 画面で目に見える出来事にだけ置く: カードが現れる、チップが動く・着く、流れ図の段が光る、チェックが付く、
  取り消し線が引かれる、拒否される。`at` は、その動きに渡した `film.at(場面, 秒)` の秒にする
- 数: 1 場面 1〜3 個。0.4 秒以内に続く 2 つの動きには、目立つ方にだけ付ける。全開の頭から 1 小節の間には置かない
- 同じ種類の出来事には同じ `prompt` と `duration` を使う（音がそろい、同じものは 1 回しか作られない）
- 短く: 0.5〜1.5 秒。長い上昇音・環境音・音楽・声は頼まない
- `prompt` は英語で、柔らかさを指定する（`soft`・`subtle`・`gentle`）。ナレーションより前に出ないこと

| 出来事             | `prompt` の例                          | `duration` |
| ------------------ | -------------------------------------- | ---------- |
| カード・部品が出る | soft UI pop                            | 0.6        |
| カードが横から入る | soft paper slide swish                 | 0.6        |
| チップが移動する   | quick airy whoosh                      | 0.8        |
| チェックが付く     | soft tick click                        | 0.5        |
| 取り消し線         | short soft marker strike               | 0.5        |
| 段が光る・強調     | gentle glassy chime                    | 1.0        |
| 拒否・失敗         | soft muted denial thud, short low bump | 0.6        |
| 完了・成功         | soft positive notification chime       | 1.2        |

`motion-render sfx <work>` で作る（裏で動かしてよい）。`build` は、効果音ごとに音量をナレーションの平均より 4 dB 下にそろえ、
`volume` を掛け、`duration` で切り、両端をフェードしてから混ぜる。無音で返ってきた効果音は `sfx` が作り直し、3 回とも無音なら止まる。
試聴用の `audio/sfx/preview.m4a` のパスと順番を報告し、合わない音があれば教えてほしいと頼む。

**表記**: 月額プランなしで作った効果音は、商用に使えず、公開するときは題名に `elevenlabs.io` か `11.ai` を入れる
（ElevenLabs のヘルプ「Can I publish the content I generate on the platform?」）。効果音を付けた動画では、
タイトルの場面に `🎧:11.ai` を小さく入れる。利用者が月額プランに入っていると言った場合は省いてよい。

## Motion で作るとき

利用者が Claude Motion を指定したときだけ使う。一打ごとの反応は書けないので、曲は山場（区間の頭）に合わせるところまでにする。

1. `Artifact` の `quickstart`（`intent: "other"`）か `list`（`scope: "types"`）で Motion 型を探し、`type_url` に `title` を付けて作る
2. 返ってきた Motion 型の指示に従って場面を作る。質問はしない。`scenes.json` の場面の `id`・`dur` は `timing.json` と同じにする。
   Motion 内蔵の BGM（`score.js`）は作らない
3. 曲は手順 4・6 と同じに作る（`bgm`・`score`）。`sync` の一打の項目（kicks in the drops）は満たせないので、語りと山場の項目だけを見る
4. 映像データを取得して MP4 にする:
   1. `Artifact` の `read` で `paths: ["index.html", "artifact-type/app.js", "artifact-type/app.css"]`、`out_dir: <work>/film`
   2. `ArtifactData` の `list`（`collection: "modules"`）と `get`（`film`/`script`）を `out_dir: <work>/store` で保存
   3. `motion-render prepare <work>/store <work>/film`
   4. `motion-render stills` で全場面を見てから `motion-render build <work>`

### 既存の Motion の動画を MP4 にするとき

URL を渡された場合も音を付ける。映像データを取得し（上の 4）、`scenes.json` の場面ごとに、その秒数に収まる
ナレーションを書く（1 秒あたり 7〜8 字が目安。`id` は `scenes.json` と同じにする）。場面の長さが決まっているので
`bpm` は付けず、`bgm` に英語の指示文（作風・楽器・気分）を書いて `motion-render bgm` で 1 曲作る。`build` はナレーションを
動画の実際の場面の開始時刻に置き、場面に収まらないナレーションがあれば警告を出す。警告が出たら、原稿を削るか
`speed` を上げて `narrate` からやり直す。

## ファイル

- `scripts/cli.ts`・`scripts/beatcli.ts`: `motion-render` コマンド（TypeScript。Node 22.18 以上がそのまま実行する）
- `scripts/audio.ts`: Gemini TTS・Lyria の呼び出し（90 秒の上限と再試行付き）、曲の候補、音声の合成
- `scripts/score.ts`: 曲の候補を小節ごとに測った表、選んだ小節の並べ替えと書き出し、山場の点検（`score`）
- `scripts/signal.ts`・`scripts/tempo.ts`・`scripts/hits.ts`: 音の読み込み、テンポと小節の頭、16 分音符ごとの打音の検出
- `scripts/sync.ts`: MP4 で語り・山場・一打の同期を測る（`sync`。`build` も実行する）
- `scripts/sfx.ts`: ElevenLabs による効果音の生成（`sfx`）、音量の測定とそろえ方、試聴用ファイル
- `scripts/work.ts`: `script.json` の検証、`timing.json` の計算（拍と小節にそろえる）、ナレーションを場面の開始時刻に置く処理
- `scripts/render.ts`: プレーヤーを開いてコマを返す。描画中は外部への通信を遮断し、Chromium の sandbox を有効にする
- `scripts/kit.ts`・`kit/`: html の映像のプレーヤー（`player.js`）、音ハメの部品（`beat.js`）、土台・作風・部品の CSS を、フォントと GSAP と一緒に置く（`kit`）
- `scripts/scenes.ts`: `film/scenes/*.html` を index.html の `<!-- scenes -->` に差し込んで、描画するページにする
- `scripts/layout.ts`・`scripts/snapshot.js`・`scripts/repeat.ts`: html の映像の確認（配置、短すぎる文字、巻き戻しで変わる絵。`check`。`stills`・`build` も実行する）
- `scripts/steps.ts`: 各コマンドの開始と終了を `<work>/steps.jsonl` に残し、工程ごとの時間の表にする（`times`）
- `references/html-film.md`: html の映像の書き方、音ハメの演出と書き方、配置の決まり、部品、場面を分けて書くときの決まり
- `references/pipeline.md`: 工程のつながり（何を待ち、何を裏で動かすか）と、工程を足すときの決まり
- `scripts/json.ts`: ファイル・API・プレーヤーから来る JSON を、形を確かめながら読む
- `scripts/store.ts`: Motion の store（ArtifactData の保存先）を映像データのフォルダに展開する（`prepare`）
