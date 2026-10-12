# Creating a Gemini API key in Google AI Studio

[日本語](api-key.ja.md)

motion-render makes the narration (Gemini TTS) and the BGM (Lyria) through the Gemini API with an API key. This page covers creating the key in Google AI Studio and handing it to motion-render.

## 1. Create the key

1. Open the [API keys page](https://aistudio.google.com/api-keys) in Google AI Studio and sign in with your Google account.
2. On first use, accept the terms of service. AI Studio then creates a default Google Cloud project for you.
3. Click **Create API key**.
4. Choose a project. Use the default project, or **Create API key in new project** to keep this key separate from other uses.
5. Copy the key string that is shown.

Every key belongs to a Google Cloud project, and billing and rate limits are tracked per project. To use a project that already exists in Google Cloud but is not listed, open **Projects** from the dashboard, click **Import projects**, and select it.

> [!NOTE]
> Since May 28, 2026, new keys created in AI Studio are authorization keys (auth keys). The Gemini API rejects unrestricted standard keys. If the **Key type** column on the API keys page shows **Standard** for your key, create a new one and delete the old one. See [Using Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key).

## 2. Set the key

motion-render reads the key from the `GEMINI_API_KEY` environment variable. Do not commit the key to a repository or your dotfiles.

In your shell profile:

```sh
# ~/.zshrc etc.
export GEMINI_API_KEY="..."
```

On macOS, to keep the key out of files, store it in the Keychain and read it when the shell starts (the key is entered at a prompt, so it stays out of your shell history):

```sh
security add-generic-password -a "$USER" -s gemini-api-key -w
```

```sh
# ~/.zshrc etc.
export GEMINI_API_KEY="$(security find-generic-password -a "$USER" -s gemini-api-key -w)"
```

Then restart Claude Code. A running Claude Code keeps the environment it started with.

## 3. Check the key

List the available models to confirm the key works.

```sh
curl -s "https://generativelanguage.googleapis.com/v1beta/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" | head
```

If you get a JSON list of models, the key works. An `error` with `API_KEY_INVALID` or `PERMISSION_DENIED` means the key is wrong, blocked, or restricted to other APIs.

## Free and paid tiers

New projects start on the free tier. On the free tier, what you send may be used to improve Google's products ([Gemini API Terms](https://ai.google.dev/gemini-api/terms)). To keep your narration scripts out of that, or to raise rate limits, click **Set up billing** on the **Plan & Pricing** or **Settings** page in AI Studio to move the project to the paid tier.

## If the key leaks

Delete the key on the API keys page and create a new one. Anything still using the deleted key stops working, so replace it with the new key.
