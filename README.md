# Bharath-AI

**Live site:** https://bharath-vayu.github.io/Bharath-AI/  
**Transcriber:** https://bharath-vayu.github.io/Bharath-AI/transcriber/

A GitHub Pages site that hosts small tools. Each tool runs in the browser from this site and, where one exists, also
ships as a Windows download under Releases.

```
index.html              the hub page (list of tools)
transcriber/            Transcriber, browser edition (index.html, app.js, stt-worker.js, icon.svg)
test/check.mjs          headless smoke test (layout + all four exports)
```

## Publish (one time, 5 minutes)

1. Create a repository on GitHub named `Bharath-AI` (public).
2. Upload everything in this folder to it (drag and drop in the GitHub web UI works, or `git push`).
3. In `index.html` replace the two `GITHUB_USER` placeholders with your GitHub username.
4. Repository **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
5. After a minute the site is live at `https://<your-username>.github.io/Bharath-AI/`.
   Transcriber is at `https://<your-username>.github.io/Bharath-AI/transcriber/`.

To add the Windows download: **Releases → Draft a new release**, tag `transcriber-v1`, attach `Transcriber.zip`, publish.
The hub's "Download for Windows" button points at the latest release.

Every later change is just editing files in the repo; Pages redeploys automatically.

## Transcriber (browser edition)

Open the page, press **Start**, pick the screen or tab to share with **Share system audio** / **Share tab audio** ticked,
allow the microphone. Press **Stop** to get the export bar (Text, HTML, PDF, Word, optional Save to Google Drive).

How it works, all inside the browser, nothing uploaded:

- **Vosk** prints words as they are spoken and decides where each sentence ends.
- **whisper** (transformers.js) rewrites each finished sentence more accurately a few seconds later; if the machine
  cannot keep up, the Vosk text simply stays.
- **WavLM speaker embeddings** label remote voices Speaker 1, Speaker 2, ... per sentence. You are "Me".
- **Screenshots** from the share every N seconds (default 60), identical frames skipped.
- All three switches and the interval work while recording. Turning a source off pauses it; turning on a source that
  was never started prompts for the share or the microphone.

The three models (about 180 MB in total) download the first time the page is opened, with a progress readout in the
status line, and are cached in the browser after that. Later visits take about 5 seconds to get ready, in the
background. `coi-serviceworker.min.js` enables multi-threading for whisper; it reloads the page once on the very first
visit, which is expected.

Tips: wear headphones so the microphone hears only you. A window share carries no audio on Windows; share the whole
screen or the tab. The Windows app in Releases does the same job fully offline with no share prompt.

## Save to Google Drive (optional, one time)

Anyone using the site can save transcripts into their own Google Drive. Setup is a free Google Cloud OAuth client:

1. https://console.cloud.google.com → create a project (any name).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill app name and your email → Scopes: add
   `.../auth/drive.file` → Test users: add your Gmail (and anyone else who will use it) → save.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Web application →
   Authorized JavaScript origins: `https://<your-username>.github.io` → Create. Copy the Client ID.
5. Open Transcriber, click the gear, paste the Client ID, Save. It is stored in that browser only.

"Save to Google Drive" then signs in with Google and uploads into a `Transcriber` folder in the signed-in account's
Drive. The `drive.file` scope only lets the app see files it created. While the consent screen is in "Testing", only
the test users you listed can sign in; click "Publish app" on the consent screen to open it to everyone.

## Adding a tool later

Make a folder `<tool>/` with its own `index.html`, add a card to the hub `index.html`, push. If the tool also has a
Windows build, attach its zip to a release and link it from the card.

## Test

`node test/check.mjs` (needs Playwright) loads the pages headless, injects a sample session, triggers every export and
writes screenshots and files to `test/out/`.
