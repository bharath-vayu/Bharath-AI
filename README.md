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

- **Your microphone** uses the browser's own recognizer (Chrome/Edge): instant, phrase-aware, no download. Labeled "Me".
- **The shared audio** goes through Vosk (live words, sentence boundaries), then whisper (transformers.js) rewrites each
  finished statement more accurately a few seconds later; if the machine cannot keep up, the Vosk text simply stays.
  On a machine with WebGPU (Chrome/Edge with a working GPU) the larger whisper small.en runs on the GPU (~300 MB once);
  otherwise whisper base.en runs on the CPU. The status line says which one is active after loading.
- Each statement is scanned in 2-second windows for voice changes and split where the voice changes, so quick
  back-and-forth between people comes out as separate labeled rows even without a pause.
- **WavLM speaker embeddings** label the remote voices Speaker 1, Speaker 2, ... per sentence. Until that model has
  finished starting (20-40 s after the page opens), sentences are labeled "Others".
- **Screenshots** from the share every N seconds (default 60), identical frames skipped.
- All three switches and the interval work while recording. Turning a source off pauses it; turning on a source that
  was never started prompts for the share or the microphone.

The models (about 180 MB in total) download the first time the page is opened, with a progress readout in the
status line, and are cached in the browser after that. Later visits take about 5 seconds to get ready, in the
background. `coi-serviceworker.min.js` enables multi-threading for whisper; it reloads the page once on the very first
visit, which is expected.

Tips: wear headphones so the microphone hears only you. A window share carries no audio on Windows; share the whole
screen or the tab. The Windows app in Releases does the same job fully offline with no share prompt.

### On a phone or tablet

Mobile browsers cannot capture the screen or system audio (a platform rule, not a setting), so the page switches to
**phone mode** automatically: microphone only, the browser's own recognizer, no model downloads. Put the phone where it
hears everyone; every line is labeled "Mic". Exports work the same. Add it to the home screen from the browser menu to
launch it like an app.

## Save to Google Drive (optional, one time)

Anyone using the site can save transcripts into their own Google Drive. Setup is a free Google Cloud OAuth client:

1. https://console.cloud.google.com → create a project (any name).
2. **APIs & Services → Library** → enable **Google Drive API**.
3. **APIs & Services → OAuth consent screen** → External → fill app name and your email → Scopes: add
   `.../auth/drive.file` → Test users: add your Gmail (and anyone else who will use it) → save.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Web application →
   Authorized JavaScript origins: `https://<your-username>.github.io` → Create. Copy the Client ID.
5. Open Transcriber → Settings, paste the Client ID, Save, then **Connect Google Drive** and sign in once.

From then on every session is saved automatically (text and screenshots) to `Transcriber/sessions` in that account's
Drive, during the recording every 3 minutes and at Stop, and listed under **My recordings** on any device where you
connect. "Save to Google Drive" in the transcript bar additionally uploads an export in the format you pick.
The `drive.file` scope only lets the app see files it created. Google issues one-hour tokens to web pages; the page
renews them silently. On the consent screen click **Publish app** (no review is needed for this scope), otherwise
Google expires the sign-in after 7 days while the app is in "Testing".

## Adding a tool later

Make a folder `<tool>/` with its own `index.html`, add a card to the hub `index.html`, push. If the tool also has a
Windows build, attach its zip to a release and link it from the card.

## Test

`node test/check.mjs` (needs Playwright) loads the pages headless, injects a sample session, triggers every export and
writes screenshots and files to `test/out/`.
