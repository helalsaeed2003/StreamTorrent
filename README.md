# StreamTorrent

Watch what is inside a torrent without downloading the whole thing.

Open a torrent, see its files as a folder tree, play any one of them straight
away. Only the pieces of the file you are watching are fetched.

Windows app, built on [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop)
with an embedded [mpv](https://mpv.io), so HEVC, 10-bit, `.mkv`, `.avi`, `.wmv`,
EAC3, DTS and embedded subtitles all play with nothing to install.

## Download

From the **[Releases page](https://github.com/helalsaeed2003/StreamTorrent/releases/latest)**:

- **`StreamTorrentSetup.exe`** — the installer. This is the one you want. No
  administrator password, and it updates itself from then on.
- **`StreamTorrent-<version>-win.zip`** — portable. Unzip anywhere, run
  `StreamTorrent.exe`. Settings stay in the folder beside it. Does not update
  itself.

Windows 10 or later, 64-bit.

The first run shows **Windows protected your PC**, because the installer is not
signed with a code-signing certificate. Click **More info**, then **Run
anyway**. Once.

## What it does

- Plays any file in a torrent before the rest of it has arrived
- The seek bar shows the stretches that have actually downloaded, in pieces
- Offers to carry on from where you stopped, and lists everything you are
  partway through
- Subtitles, audio tracks and speed (0.25× to 4×) in menus over the video
- Files as a folder tree with search (`Ctrl+F`); opens fast with tens of
  thousands of files
- Opens `.torrent` files and `magnet:` links, watches a folder, makes torrents
- Sends video to a TV over Chromecast, AirPlay or DLNA
- Nothing phones home. Downloads are deleted when you quit

## Your data

Kept outside the program folder, so installing and updating never touch it:

```
%LOCALAPPDATA%\StreamTorrentData\
```

Holds the torrent list, where you got to in each video, and settings. The
portable build keeps the same thing in `Portable Settings` beside the
executable. To start over, quit and delete that folder.

## Building it

Needs [Node.js](https://nodejs.org) 18 or newer, and Windows.

```bash
git clone https://github.com/helalsaeed2003/StreamTorrent.git
cd StreamTorrent
npm install
npm run fetch-mpv
npm start
```

`npm run fetch-mpv` downloads mpv (34 MB) and checks its SHA-256 before
unpacking it into `vendor/mpv`; it is too large to keep in the repository.
`npm run package` builds the installer and the portable zip into `dist/`.

Releasing a new version: [RELEASING.md](RELEASING.md).

## Credit and licences

A fork of [WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop)
by WebTorrent, LLC, still running the
[WebTorrent](https://github.com/webtorrent/webtorrent) engine. Its MIT licence
and copyright are kept in [LICENSE](LICENSE).

StreamTorrent is MIT. mpv and FFmpeg ship inside it under the GPL and LGPL;
every bundled component, its licence and where to get its source are in
[licenses/](licenses/), and in the app under **Help → About → Licences**.

## A note on what you download

StreamTorrent is a BitTorrent client. What you do with it is your
responsibility. It comes with no content, no index, no search, and no links to
anything.
