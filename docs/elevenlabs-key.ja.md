# ElevenLabs で効果音用の API キーを作る

[English](elevenlabs-key.md)

motion-render は、アニメーションに合わせた効果音を ElevenLabs の Sound Effects API で作る。効果音は任意で、`ELEVENLABS_API_KEY` が無ければ付かない（ナレーションと BGM だけの動画になる）。このページでは、月額プランに入らずに従量課金（Pay As You Go）でキーを作り、motion-render に渡すまでを説明する。

## 1. 残高を入れる

Sound Effects API は無料プランでは使えない。従量課金の残高を入れると使えるようになる。月額プランへの加入は要らない。

1. [elevenlabs.io](https://elevenlabs.io) でアカウントを作り、ログインする。
2. [Developers](https://elevenlabs.io/app/developers) を開く。
3. **Usage**（使用状況）の **Add credits**（クレジットを追加）を押す。隣の月額プランへの加入ボタンとは別物なので注意する。
4. 金額を入れる。最低 $5。月額プランをすすめる確認が出たら、そのまま進める（日本語の画面では「チャージ」）。
5. 支払い方法を選んで払う。カードを登録していなくても、Stripe の画面で払える。
6. 自動チャージ（Auto Top Up）は使わなくてよい。

画面に「Pay As You Go」（従量課金プラン）と出れば完了。残高が 0 になると API はその場で止まり、後から請求されることはない。入れた残高は払い戻されず、購入から 12 か月で失効する。

## 2. キーを作る

1. Developers の **API Keys** タブで、新しいキーを作る。名前は `motion-render` など。
2. **Restrict key**（キーを制限）をオンのままにし、**Sound Effects**（サウンドエフェクト）だけを **Access** にする。ほかはすべて **No Access** のままにする。漏れたときの被害を効果音の生成に限るため。
3. 使用制限（クレジット）は空欄でよい。残高を超えて使われることはない。
4. 作成すると、キーが 1 回だけ表示される。後からは末尾 4 文字しか見られないので、すぐにコピーする。

## 3. キーを設定する

motion-render は環境変数 `ELEVENLABS_API_KEY` からキーを読む。キーをリポジトリや dotfiles にコミットしないこと。

```sh
# ~/.zshrc など
export ELEVENLABS_API_KEY="..."
```

macOS のキーチェーンに入れる方法は、[Gemini のキーの手順](api-key.ja.md#2-キーを設定する)と同じ（サービス名を変える）。設定したら Claude Code を起動し直す。

## 料金

出力の秒数に比例する。2026 年 10 月に確かめた値で、1 秒あたり約 5 クレジット、約 $0.002。1 秒の効果音を 10 個付けた動画で約 $0.02。同じ `prompt` と `duration` の効果音は 1 回しか作らないので、作り直しても変えた分しか課金されない。

## 公開と商用利用

ElevenLabs のヘルプ（[Can I publish the content I generate on the platform?](https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform)）では、商用ライセンスが付くのは有料の月額プランで作ったものだけで、それ以外は非商用に限られ、公開するときは題名に `elevenlabs.io` か `11.ai` を入れる。従量課金についての記述は無い。

motion-render は、効果音を付けた動画のタイトルの場面に `🎧:11.ai` を入れる。商用に使う動画には、月額プランに入ってから効果音を作ること（プラン外で作った音は、後から加入しても商用に使えない）。

## キーが漏れたとき

API Keys タブでそのキーを削除し、新しいキーを作る。
