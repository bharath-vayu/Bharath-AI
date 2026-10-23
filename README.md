# Bharath-AI

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

- **Microphone (me)** uses the browser's speech recognition (Chrome/Edge). Words appear as you speak, labeled "Me".
- **System audio (others)** comes from a screen share. On Start the browser asks what to share; tick **Share system
  audio** (entire screen) or **Share tab audio** (a tab). Two engines run in the browser, both downloaded once and cached
  (~40 MB each): Vosk prints words as they are spoken and finalizes each sentence, then whisper (transformers.js)
  rewrites that sentence more accurately in the background. If the machine is too slow to keep up, the Vosk text stays.
  A window share carries no audio on Windows; share the whole screen or the tab instead.
- `coi-serviceworker.min.js` turns on cross-origin isolation so whisper can use several CPU threads. It reloads the page
  once on the very first visit; that is expected.
- **Screenshots** are taken from the same share every N seconds (default 60); frames identical to the previous one are skipped.
- **Stop** shows the export bar: Text, HTML, PDF, Word, plus "Include screenshots". HTML embeds the images so it is a
  single file. The transcript is also kept in the browser's local storage until you export or discard it, so a closed tab
  is recoverable.

Differences from the Windows app: no Speaker 1 / Speaker 2 labels (only Me / Others) and the whisper model is the
smaller base.en. Audio never leaves the machine
except for the microphone, which Chrome/Edge send to Google/Microsoft for recognition.

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
