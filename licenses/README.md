# Third-party licences

StreamTorrent itself is MIT-licensed — see [LICENSE](../LICENSE) in the root of
this repository. It carries WebTorrent, LLC's copyright for the code it is
built on, and helalsaeed2003's for the changes made here.

What follows is everything that ships inside a StreamTorrent installer or
portable build but was written by someone else. The full licence text of each
one is in this folder, and the same texts are shown inside the app under
**Help → About → Licences**.

## Shipped inside the installer

### mpv

The video engine. Everything the app plays goes through it, and `mpv.exe`
sits in `resources/mpv` next to the app.

- Version: `v0.42.0-5-g55d3feb45`, built 2026-11-08
- Licence: GPL-2.0-or-later, with most of it also available under
  LGPL-2.1-or-later — [mpv-Copyright.txt](mpv-Copyright.txt),
  [mpv-LICENSE.GPL.txt](mpv-LICENSE.GPL.txt),
  [mpv-LICENSE.LGPL.txt](mpv-LICENSE.LGPL.txt)
- Source: https://github.com/mpv-player/mpv
- The exact Windows build shipped here, and the scripts that made it:
  https://github.com/shinchiro/mpv-winbuild-cmake
- Downloaded at build time by [`bin/fetch-mpv.js`](../bin/fetch-mpv.js), which
  checks it against a pinned SHA-256 before unpacking it. It is not kept in
  this repository, because it is larger than GitHub will accept.
- mpv publishes no Windows binaries of its own: [mpv.io/installation](https://mpv.io/installation)
  says every Windows package is a third-party build, and points at this one
  first. The archive is fetched from whichever of these answers, all checked
  against the same hash: a copy kept with this project's own releases, the
  same build on
  [SourceForge](https://sourceforge.net/projects/mpv-player-windows/files/64bit/),
  and the original upstream release.

mpv is used as a separate program, started as its own process and spoken to
over a pipe. It is not linked into StreamTorrent.

### FFmpeg

Inside mpv — it is what actually decodes the video and audio.

- Version: `N-128607-g1ddef7d76`, the build that comes with the mpv above
- Licence: LGPL-2.1-or-later, and GPL-2.0-or-later for the parts built with
  `--enable-gpl` — [ffmpeg-LICENSE.md.txt](ffmpeg-LICENSE.md.txt),
  [ffmpeg-COPYING.LGPLv2.1.txt](ffmpeg-COPYING.LGPLv2.1.txt),
  [ffmpeg-COPYING.GPLv2.txt](ffmpeg-COPYING.GPLv2.txt)
- Source: https://git.ffmpeg.org/ffmpeg.git — also mirrored at
  https://github.com/FFmpeg/FFmpeg

### libplacebo

Inside mpv, for video rendering.

- Version: `v7.387.0`
- Licence: LGPL-2.1-or-later — the text is
  [the same LGPL](ffmpeg-COPYING.LGPLv2.1.txt) as above
- Source: https://code.videolan.org/videolan/libplacebo

### d3dcompiler_43.dll

Microsoft's HLSL shader compiler, which mpv's Direct3D output needs on
machines that do not already have it. It comes from the same mpv build and is
redistributable under Microsoft's DirectX redistributable terms.

- Source: part of the DirectX End-User Runtime, redistributed by the mpv
  Windows build above

### Electron

The application framework — Chromium and Node.js.

- Version: `27.3.11`
- Licence: MIT — [electron-LICENSE.txt](electron-LICENSE.txt)
- Source: https://github.com/electron/electron
- Chromium, Node.js and their own dependencies carry their own licences, which
  are listed inside every Electron build in `LICENSES.chromium.html` — that
  file ships in the installer beside the executable.

## Node packages

Everything under `node_modules` that is bundled into `app.asar`. They are all
MIT, ISC, BSD or Apache-2.0; each package keeps its own licence file in its own
folder, and `npm ls` or `npx license-checker` will list them against a checkout.
The ones the app leans on most:

| Package | Licence | Source |
| --- | --- | --- |
| webtorrent | MIT | https://github.com/webtorrent/webtorrent |
| react, react-dom | MIT | https://github.com/facebook/react |
| material-ui | MIT | https://github.com/mui/material-ui |
| electron-updater | MIT | https://github.com/electron-userland/electron-builder |
| music-metadata | MIT | https://github.com/borewit/music-metadata |
| chromecasts, airplayer | MIT | https://github.com/feross |

## What is not shipped

VLC is mentioned in the code as an *external* player — files the built-in
player cannot show are handed to whatever the machine already has installed.
Nothing of VLC's is included here.

## Source for the GPL parts

mpv and the GPL parts of FFmpeg are distributed here as unmodified binaries.
Their complete corresponding source is at the links above, at the exact
versions named, and `bin/fetch-mpv.js` records the build those binaries came
from.
