# Creating an ElevenLabs API key for sound effects

[日本語](elevenlabs-key.ja.md)

motion-render makes sound effects that follow the animation with the ElevenLabs Sound Effects API. Sound effects are optional: without `ELEVENLABS_API_KEY`, the video gets narration and BGM only. This page shows how to create a key on pay-as-you-go, without a subscription, and hand it to motion-render.

## 1. Add credits

The Sound Effects API is not available on the free plan. A pay-as-you-go balance unlocks it; no subscription is needed.

1. Sign up at [elevenlabs.io](https://elevenlabs.io) and log in.
2. Open [Developers](https://elevenlabs.io/app/developers).
3. Under **Usage**, choose **Add credits**. It is not the subscription button next to it.
4. Enter an amount (at least $5). If you are offered a subscription first, continue with the top-up.
5. Pay. A saved card is not required: the Stripe checkout takes the payment.
6. Auto Top Up can stay off.

The account now shows "Pay As You Go". When the balance reaches zero, the API stops at once; you are never billed afterwards. Top-ups are not refundable and expire 12 months after purchase.

## 2. Create the key

1. In the **API Keys** tab of Developers, create a key, for example `motion-render`.
2. Keep **Restrict key** on and set only **Sound Effects** to **Access**; leave everything else at **No Access**. A leaked key can then only make sound effects.
3. Leave the credit limit empty: usage can never exceed the balance.
4. The key is shown once. Copy it now: afterwards only its last four characters are visible.

## 3. Set the key

motion-render reads the key from `ELEVENLABS_API_KEY`. Do not commit the key to a repository or dotfiles.

```sh
# ~/.zshrc etc.
export ELEVENLABS_API_KEY="..."
```

To keep it in the macOS keychain instead, follow the [Gemini key steps](api-key.md#2-set-the-key) with a different service name. Restart Claude Code after setting it.

## Cost

Billed by the second of output. Measured in October 2026: about 5 credits, roughly $0.002, per second. Ten one-second effects cost about $0.02. An effect with the same `prompt` and `duration` is made only once, so a rebuild only pays for what changed.

## Publishing and commercial use

According to the ElevenLabs help center ([Can I publish the content I generate on the platform?](https://elevenlabs.io/docs/help-center/legal/can-i-publish-the-content-i-generate-on-the-platform)), only content made on a paid subscription carries a commercial license. Anything else is for non-commercial use only and must be credited with `elevenlabs.io` or `11.ai` in its title when published. The page does not mention pay-as-you-go.

motion-render puts `🎧:11.ai` on the title scene of a video with sound effects. For a commercial video, subscribe before making its effects: audio made outside a subscription does not become licensed when you subscribe later.

## If the key leaks

Delete the key in the API Keys tab and create a new one.
