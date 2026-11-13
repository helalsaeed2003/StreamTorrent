# StreamTorrent

Watch what is inside a torrent without downloading the whole thing.

StreamTorrent opens a torrent, shows you its files as a folder tree, and plays
any one of them straight away — it fetches only the pieces of the file you are
actually watching. A 500 GB torrent with twenty thousand files in it opens in a
second, and watching one clip out of it costs you that clip.

It is a Windows app, built on [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop),
with the video side rebuilt around an embedded [mpv](https://mpv.io) so that
anything plays: HEVC, 10-bit, EAC3 and DTS audio, `.mkv`, `.avi`, `.wmv`, and
subtitles burned into the file.

## Screenshots

<!-- Replace these with real screenshots before sharing the repo around.
     Drop the images in docs/screenshots/ and keep the file names. -->

| The torrent list | A torrent opened up |
| --- | --- |
| ![The torrent list](docs/screenshots/torrent-list.png) | ![A torrent opened up](docs/screenshots/torrent-details.png) |

| Playing something | Preferences |
| --- | --- |
| ![Playing something](docs/screenshots/player.png) | ![Preferences](docs/screenshots/preferences.png) |

## What it does

**Watching**

- Plays any file in a torrent without waiting for the rest of it, and without
  downloading the files you did not ask for
- Embedded mpv engine, so formats that stop other players just play
- The red bar under the video shows the stretches of the file that have
  actually arrived — not one bar growing from the left, so it still means
  something after you skip
- Picks up where you left off: a video you stopped halfway through offers to
  carry on from there, and the **Continue watching** row at the top of the list
  shows everything you are partway through
- Subtitles, audio tracks and playback speed all have their own menus over the
  video; subtitle files can be added by hand, and the choice is remembered per
  file
- Keyboard controls for play, skip, step, volume and speed, and full screen
- Sends video to a TV over Chromecast, AirPlay or DLNA when you want it

**Getting around a torrent**

- Files are shown as a folder tree, like a file explorer — only the folders you
  open are drawn, so a torrent of tens of thousands of files stays quick
- **Ctrl+F** searches inside the open torrent by file and folder name, and the
  box remembers the last five things you looked for and finishes them as you
  type
- A cloud button next to any file or folder fetches it in the background
- Drag a torrent by its title to reorder the list
- Torrents can be paused, resumed and removed, with or without their data

**Around the edges**

- Opens `.torrent` files and `magnet:` links, and can make itself the default
  for both
- Watches a folder and adds any `.torrent` dropped into it
- Makes torrents out of your own files
- Gives the file being watched priority over everything else downloading
- Your own tracker list
- Desktop and Start menu shortcuts, chosen when you install
- A portable build that keeps everything beside the executable

**Where the data goes**

Everything downloaded goes to a scratch folder and is **deleted when you quit**.
Nothing fills your disk behind your back. What is kept is the list of torrents
and where you got to in each one — see [Your data](#your-data).

## Download and install

Go to the **[Releases page](https://github.com/helalsaeed2003/StreamTorrent/releases/latest)**
and take one of these:

| File | What it is |
| --- | --- |
| `StreamTorrentSetup.exe` | The installer. **This is the one you want.** Installs for your user only, no administrator password, and updates itself from then on. |
| `StreamTorrent-<version>-win.zip` | Portable. Unzip it anywhere, run `StreamTorrent.exe`. Keeps its settings in the folder beside it and does not update itself. |

### "Windows protected your PC"

The first time you run the installer Windows will put up a blue box saying
**Windows protected your PC** and *Microsoft Defender SmartScreen prevented an
unrecognised app from starting*.

That is expected. It means the installer is not signed with a code-signing
certificate, which costs a few hundred pounds a year, and nothing more than
that. To get past it:

1. Click **More info** — the small link under the message
2. Click **Run anyway** — the button that appears at the bottom

You will see this once. After that Windows recognises it.

The same box may appear the first time the app updates itself.

### Updating

The installed version checks for a new release when it starts and every few
hours after that, downloads it quietly in the background, and then offers
**Update ready: restart to install** with **Restart now** or **Later**. It
never interrupts a video — if something is playing, it waits.

You can also check whenever you like: **Help → Check for Updates**.

The portable build does not update itself. It tells you when there is a newer
version and opens the Releases page so you can fetch it.

## Your data

Everything StreamTorrent keeps lives in your Windows user folder, **not** in
the program folder, so installing, updating and uninstalling never touch it:

```
%LOCALAPPDATA%\StreamTorrentData\
    config.json     the torrent list, where you got to in each video, and settings
    Torrents\       the .torrent files for the list
    Posters\        thumbnails
    Temp\           what is being watched right now, cleared on quit
```

Paste `%LOCALAPPDATA%\StreamTorrentData` into Explorer's address bar to open it.

The portable build keeps the same thing in a `Portable Settings` folder next to
`StreamTorrent.exe` instead.

To start over, quit the app and delete that folder.

## Building it yourself

You need [Node.js](https://nodejs.org) 18 or newer, and Windows.

```bash
git clone https://github.com/helalsaeed2003/StreamTorrent.git
cd StreamTorrent
npm install
npm run fetch-mpv
npm start
```

`npm run fetch-mpv` downloads the exact mpv build the app is made against — 34
MB — and checks it against a SHA-256 before unpacking it into `vendor/mpv`. It
is not kept in this repository because it is 116 MB unpacked, well over what
GitHub accepts. Run it once; after that it does nothing unless the build
changes.

To make the installer and the portable zip:

```bash
npm run package
```

They land in `dist/`.

Other things worth knowing:

```bash
npm test           # standard (linting) and depcheck
npm run build      # compile src/ to build/ with babel, which npm start does too
npm run watch      # rebuild and restart as you edit
```

The code is split into a main process (`src/main`), the window you see
(`src/renderer`), and a hidden window that runs the torrent engine on its own
so a busy swarm cannot make the interface stutter (`src/renderer/webtorrent.js`).
mpv runs as a separate program and draws into a window placed over the page,
which is why the player's bars live in windows of their own (`static/player-chrome.js`).

## Based on WebTorrent Desktop

StreamTorrent is a fork of [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop)
by WebTorrent, LLC, and would not exist without it. The torrent engine is still
[WebTorrent](https://github.com/webtorrent/webtorrent). The original MIT licence
and copyright are kept in [LICENSE](LICENSE).

The changes here are mostly: the embedded mpv engine in place of the browser's
own video tag, the folder tree and search, preloading, the resume behaviour, the
player chrome drawn in separate windows, and the Windows installer and
auto-update setup.

## Licences

StreamTorrent is MIT. mpv and FFmpeg ship inside it and are free software under
the GPL and LGPL. Every bundled component, its licence and where to get its
source are listed in [licenses/](licenses/), and the same texts are in the app
under **Help → About → Licences**.

## A note on what you download

StreamTorrent is a BitTorrent client. What you do with it is up to you, and is
your responsibility. It comes with no content, no index, no search, and no
links to anything.
