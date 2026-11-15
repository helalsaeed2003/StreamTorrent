# Changelog

All notable changes to StreamTorrent are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.98.5] - 2026-11-16

### Pictures

- **Keys for stepping through a folder.** Left and right, or A and D, move one
  picture; up and down, or W and S, move ten; space starts and stops the
  slideshow; F fills the screen. A jump of ten past either end lands on the
  last picture there is rather than doing nothing.
- **A row of buttons in the middle of the bar** — ten back, one back, play,
  one on, ten on — with "17 of 3809" beside them, so a folder has a position
  and a length rather than only a next and a previous.
- **A slideshow**, at a number of seconds you set in the bar itself or in
  Preferences. It stops at the end of the folder instead of looping, and any
  step of your own restarts the wait so a slide is never cut short.
- **Zoom.** The wheel zooms around the pointer, double click goes in and back
  out, and dragging moves the picture exactly as far as the pointer moves.
- **Filling the window**, top to bottom, with a button on the bar. The edges
  of a picture shaped differently from the window are cut off, which is what
  filling it means.
- **The next pictures are fetched while you look at this one**, ten by
  default, set in Preferences. They are asked for from the torrent rather
  than fetched over HTTP: the built-in server holds a connection open until a
  file arrives and a browser allows only six to one host, so fetching ahead
  that way starved the picture on screen.

### Torrents

- Folder rows say how big a folder is, not only how many files are in it:
  "71 GB · 129 files".

### Fixed

- Dragging a picture ended in "Please go back to the torrent list before
  creating a new torrent". Chromium was dragging the picture out of the app
  and the drop landed back on the window as a file.
- A zoomed picture lurched while it was being dragged. Once it had moved far
  enough the pointer was no longer over it, so the moves stopped arriving
  until the pointer caught up with it again.
- Pictures are no longer drawn behind the bar along the bottom.

## [0.98.4] - 2026-11-15

### Changed

- **The installer asks, instead of the app.** Setup now has the page every
  Windows installer has — a desktop shortcut, a Start menu shortcut, opening
  `.torrent` files, opening `magnet:` links — with a folder page before it.
  The window that used to appear over the app after the first start is gone.
  The answers are carried out the first time the app runs, because a shortcut
  has to be named the way the app names it and a file association has to be
  written by a program running as you.
- **Torrent files and magnet links are now two settings, not one.** Either can
  be taken without the other, on that page and in Preferences. A config that
  answered for both keeps that answer.

### Fixed

- The setup questions never appeared at all with the new installer: the app
  waited for a flag that only the old Squirrel installer passed.
- Uninstalling left the shortcuts, the registered file types and the entry in
  Windows' Default apps list behind. The uninstaller now takes back everything
  it put there, and still leaves the torrent list and watch progress alone.

## [0.98.3] - 2026-11-13

First public release. StreamTorrent is a fork of
[WebTorrent Desktop](https://github.com/webtorrent/webtorrent-desktop) 0.24.0;
what follows is what is different, and what the first release can do.

### Watching

- **Embedded mpv video engine.** Video no longer goes through the browser's
  `<video>` tag. mpv runs as its own process and draws into a window placed
  over the page, so HEVC, 10-bit, EAC3, DTS, `.mkv`, `.avi`, `.wmv` and
  embedded ASS/SRT subtitles all play as they are, with nothing to install.
- **A seek bar that tells the truth.** The red part shows the stretches of the
  file that have actually arrived, as separate segments. A torrent does not
  arrive front to back, so a single bar growing from the left said nothing
  useful once you had skipped.
- **Scrubbing follows the pointer.** Dragging the handle moves it with the
  mouse rather than with whatever mpv last reported, and the video is held
  still while the handle is held, so the picture no longer jumps between where
  you are pointing and where it had got to.
- **Pick up where you left off.** A video you stopped partway through offers to
  carry on from that point. The offer waits for the video to load before it
  appears, so a slow torrent does not use it up over a black screen, and it
  comes back if you watch the same video again later.
- **Continue watching.** A row at the top of the list of everything you are
  partway through, most recent first.
- **Player menus over the video** for subtitles, audio tracks and playback
  speed, each in its own window so they can be drawn on top of mpv's output.
- Playback speed from 0.25× to 4×, stepped with `<` and `>`.
- Subtitle files can be added by hand; the choice, the audio track and the
  subtitle timing are remembered per file.

### Getting around a torrent

- **Files as a folder tree.** A torrent's files are shown the way a file
  explorer shows them, collapsed by default. Only the folders you open are
  drawn, so a torrent with 177,000 files in it opens as quickly as one with
  five.
- **Search inside a torrent** with `Ctrl+F`, matching file and folder names.
  The box remembers the last five searches, offers to finish what you are
  typing, and can be turned off in Preferences.
- **Preload.** A cloud button beside any file or folder fetches it in the
  background while you carry on.
- **Reorder** the list by dragging a torrent by its title.
- Folders start closed every time the app opens, rather than reopening
  wherever they were left.

### Windows

- **Installer** that asks, once, which shortcuts to make and whether to open
  `.torrent` files and `magnet:` links with StreamTorrent — and then actually
  takes those associations, by writing a correctly signed Windows `UserChoice`
  entry rather than only registering and hoping.
- Desktop and Start menu shortcuts written directly, so the Start menu entry
  appears where the Start menu looks for it.
- Nothing is drawn over the taskbar icon while downloading.
- A portable build that keeps its settings in a `Portable Settings` folder
  beside the executable.

### Speed

- The file list draws only the rows on screen. With a large torrent fully
  expanded this took a redraw from 366 ms to 2.5 ms, the page from 213,144
  elements to 661, and the window's memory from 1275 MB to 190 MB.
- The settings file is written without indentation, off the interface thread,
  and the saves that run on a timer do nothing when nothing has changed.
- The progress report passed between the torrent engine and the window no
  longer carries the torrent's bitfield or per-file piece numbers, which
  nothing read.

### Fixed

- A torrent that had just been added would sit at no peers for ever. With
  nothing selected the engine counted it as finished, and a finished torrent
  turns away every peer its trackers offer; asking for a file afterwards did
  not undo that. Asking for something now makes it look again.
- A short, wrong duration reported by mpv while a file was still arriving could
  mark a video as watched to the end and throw away the point you had reached.
- Finishing the setup window no longer freezes the app for several seconds.
- The default-torrent-app setting took effect but Windows kept opening the old
  program, because the user's own choice outranks registration.

### Privacy

- Nothing phones home. No telemetry, no announcement check, no update feed
  other than this repository's own releases.
- A fresh install starts empty — no bundled torrents, no history, no
  preferences carried over from anyone.
- Everything downloaded is deleted when the app quits.

[0.98.5]: https://github.com/helalsaeed2003/StreamTorrent/releases/tag/v0.98.5
[0.98.4]: https://github.com/helalsaeed2003/StreamTorrent/releases/tag/v0.98.4
[0.98.3]: https://github.com/helalsaeed2003/StreamTorrent/releases/tag/v0.98.3
