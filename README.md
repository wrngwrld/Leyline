<p align="center">
  <img src="app/assets/icon-512.png" width="128" alt="Leyline icon">
</p>

<h1 align="center">Leyline</h1>

<p align="center">
  Keeps your World of Warcraft settings and addons in sync between your computers,<br>
  through your own NAS. Start playing right away, on any machine.
</p>

---

## Why

Syncing `WTF` and `Interface/AddOns` with Dropbox or OneDrive works until it doesn't:
you wait minutes for thousands of addon files before you dare to start the game, and
starting too early leaves you with old settings or conflict files.

Leyline talks to your NAS directly over SMB and is built around how WoW actually behaves:

- **Settings first.** `WTF` folders sync before addons, so they are safe within seconds.
- **Never while playing.** A game version is never synced while it runs; Leyline syncs it
  right after you close it, when WoW has finished writing your SavedVariables.
- **Waits for your addon manager.** It watches the addon folders and syncs once changes
  have settled, so a half-finished CurseForge or WowUp update never reaches the NAS.
- **Nothing gets lost.** On a conflict the newer file wins; every replaced or deleted file
  is kept in a dated `history` folder on the NAS.
- **Every game version.** Retail, Classic, Classic Era, Anniversary, Forever, PTRs and
  betas, each switched on or off on its own, with or without addons.
- **Fast.** Checking 26,000 addon files against the NAS takes about 3 seconds.

It lives in the menu bar (macOS) or system tray (Windows), starts at login and needs no
manual steps.

## How it works

Leyline uses [rclone](https://rclone.org) `bisync` for two-way sync against an SMB share.
On the NAS it keeps:

```
<share>/<folder>/
  current/<version>/Account          live copy of WTF/Account
  current/<version>/SavedVariables   live copy of WTF/SavedVariables
  current/<version>/AddOns           live copy of Interface/AddOns
  history/<time>_<computer>/...      files a sync replaced or deleted
```

Your NAS password is encrypted with the system keychain (macOS Keychain, Windows DPAPI).

**Tip for Unraid and similar:** thousands of small addon files are slow on shares that span
several disks. A dedicated share that lives only on the SSD cache (primary storage Cache,
secondary None, exclusive access) is many times faster.

## Install

Download the latest installer from [Releases](../../releases):

- **Windows:** `Leyline-Setup-<version>.exe`. The app is not code-signed yet, so Windows
  SmartScreen shows a warning: choose *More info → Run anyway*.
- **macOS (Apple silicon):** `Leyline-<version>-arm64.dmg`. Signed and notarized by Apple,
  so it opens normally. When macOS asks whether Leyline may find devices on your local
  network, choose *Allow*; otherwise it cannot reach your NAS. You can change this later
  in *System Settings → Privacy & Security → Local Network*.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run fetch-rclone   # downloads rclone for this machine (checksum verified)
npm start
```

Useful for working on the interface without touching real data:

```bash
LEYLINE_USER_DATA=/tmp/leyline-dev LEYLINE_DEMO=syncing npm start   # idle | syncing | error | playing
```

Build installers locally with `npm run dist:win` or `npm run dist:mac`.

### Releasing

Releases are built by GitHub Actions. In the repository go to **Actions → Release → Run
workflow** and enter the new version (for example `0.2.0`). The workflow bumps the version,
tags it, builds the Windows installer and the macOS app on their own platforms, writes the
release notes from the commits since the last release and publishes the release. Tick
*dry run* to only build and download the installers from the workflow run.

## License

MIT. Leyline is not affiliated with or endorsed by Blizzard Entertainment.
World of Warcraft is a trademark of Blizzard Entertainment, Inc.
