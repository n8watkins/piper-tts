# Naming

**VoiceDock** is the name of the merged product (Piper TTS + Kokoro TTS), decided 2026-11-02.
LocalVoice was the working name on 2026-11-01, dropped because its npm name and both domains are taken.
The code, extension, docs and GitHub repo (`n8watkins/voicedock`, renamed from `n8watkins/piper-tts`) use it.
The Chrome Web Store listing is still "Piper TTS" until the next store upload.

This page keeps the availability check that picked the name with a quick availability check, then what a rename touches.

## Availability check (2026-11-01)

How each column was checked:

- **GitHub**: whether `github.com/n8watkins/<name>` is free, plus how many public repos already use the name (`gh api search/repositories?q=<name>+in:name`), as a rough measure of how crowded it is.
- **npm**: `https://registry.npmjs.org/<name>` (404 means the package name is free).
- **.dev / .app**: RDAP via `https://rdap.org/domain/<name>.dev` and `.app` (404 means no registration was found, so the domain is probably available; confirm with a registrar before relying on it).
- **Chrome Web Store**: the store's search page for the name (`https://chromewebstore.google.com/search/<name>`), looking for an extension with the same or a near-identical name in the server-rendered results.
  The store renders most results with JavaScript, so this only catches close matches.

| Name | One line | GitHub `n8watkins/` | Public repos with the name | npm | `.dev` | `.app` | Chrome Web Store |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **LocalVoice** (dropped) | Plain and descriptive: voices that run on your machine. | free | 132 | taken ("Local voice utilities", 2026) | registered | registered | "Voice Typer - Local Voice" exists (different product, similar name) |
| **VoiceDock** (chosen) | Your voices, docked on your own machine; short and brandable. | free | 19 | free | not found | not found | no match |
| **HearthVoice** | Warm, homey: the voice that lives at home with you. | free | 4 | free | not found | not found | no match |
| **VoxHaven** | A safe harbor for your text: private, local speech. | free | 0 | free | not found | not found | no match |
| **NearVoice** | The voice is near: on-device, not in a data center. | free | 7 | free | registered | not found | no match |
| **DeskVoice** | Reads aloud from your own desk; clear about where it runs. | free | 2 | free | not found | registered | no exact match ("Deal Desk Voice Connect" is unrelated) |

Also checked and dropped: **VoxLocal** and **ReadLocal** (both already exist as Chrome Web Store extensions), **Sayso**, **Lectern** and **HomeVoice** (npm and one or both domains taken).

### Takeaways

- LocalVoice is the most descriptive but the most crowded: the npm name and both domains are taken, and a store extension has a similar name.
  It works fine as a product name inside the Chrome Web Store (names don't have to be unique there), but it won't get a matching domain or npm package.
- **VoiceDock** and **VoxHaven** are the cleanest: free on GitHub, npm, `.dev` and `.app`, with no store match.
  VoiceDock reads more clearly in English; VoxHaven is the most unique.
- HearthVoice is also fully clear, but longer and less obvious to spell from hearing it.

The extension's store title can carry a descriptor either way, for example "VoiceDock: local Piper and Kokoro text to speech".

## What a rename touches

Do these together, in this order, so links never break for long.

1. **GitHub repo** (`n8watkins/piper-tts` → new name), in Settings → General → Repository name.
   GitHub redirects the old URL (web, `git clone`, `git push`, API) to the new one until a new repo takes the old name, so existing clones keep working.
   Afterwards, update local remotes anyway (`git remote set-url origin https://github.com/n8watkins/<name>.git`) on WSL and in the Windows clone.
   Links to update in this repo: the README clone command, the Setup guide and README links in `extension/src/options.jsx` (Settings, About and Credits tabs), and `.local-ops.yaml` if it is used.
2. **Product name in code** (only if the new name isn't LocalVoice): `APP_NAME` in `extension/src/shared.js`, `name` and `default_title` in `extension/manifest.json`, the page titles in `extension/popup.html` and `extension/options.html`, the server banners and 403 messages in `servers/piper/server.js` and `servers/kokoro/server.py`, the package name in `package.json`, and the docs.
   Stored settings don't depend on the name, so no migration is needed.
3. **Chrome Web Store listing**: change the item title, short description, screenshots and promo images in the Developer Dashboard, then upload the new build.
   The extension ID stays the same, so users update in place and keep their settings.
   The store reviews title changes; a title that mentions "Piper" and "Kokoro" as engines is fine, but don't use either as the product name.
   The new version adds the `http://127.0.0.1:7478/*` host permission; it is the same host as the existing 7477 permission, so Chrome shouldn't show a new permission warning, but check the dashboard's permission preview before publishing.
4. **N8 Tray module**: `n8piper` → `n8voice` (or a name matching the new product).
   That is a new module rather than a rename; see `docs/TRAY_PLAN.md`.
   Touches `C:\Users\natha\scripts\n8piper` (folder, `modular.json` id `piper-tts`, the `N8PiperTts_SingleInstance` mutex, the `piper-tts-server.exe` named Node copy) and the `piper-tts` entry in `C:\Users\natha\scripts\n8tray\config\settings.json`.
5. **Windows folders**: Chrome loads the unpacked extension from `C:\Users\natha\Projects\Tools\piper-tts\extension`.
   An unpacked extension's ID comes from its folder path, so renaming that folder resets the locally loaded extension's settings.
   Leave it, or re-create profiles after moving it (the store version is unaffected).
6. **Standalone Piper tray** (`servers/piper/tray`): its menu title and the "Piper TTS Tray" startup shortcut name.
   It is specifically the Piper server's tray, so it can keep the Piper name.
7. **kokoro-tts repo**: already points to this repo's `servers/kokoro`; update that pointer if the repo is renamed (GitHub's redirect covers it meanwhile).
