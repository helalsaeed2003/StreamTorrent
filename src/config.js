const path = require('path')
const os = require('os')
const arch = require('arch')

// Build scripts load this file with plain Node, where requiring electron throws
// if its binary has not been unpacked yet. `app` is only ever used from inside
// the Electron main process, so falling back to undefined here is harmless.
let app
try {
  ({ app } = require('electron'))
} catch (err) {
  app = undefined
}

const APP_NAME = 'StreamTorrent'
const APP_TEAM = 'WebTorrent, LLC'
const APP_VERSION = require('../package.json').version

// StreamTorrent keeps its settings in a folder of its own, so it can live side
// by side with an official WebTorrent Desktop install without the two sharing
// settings, torrents or saved magnet links.
const appConfig = require('application-config')(APP_NAME)

const ROOT_PATH = path.join(__dirname, '..')

const IS_TEST = isTest()
const PORTABLE_PATH = IS_TEST
  ? path.join(process.platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp', 'StreamTorrentTest')
  : path.join(path.dirname(process.execPath), 'Portable Settings')
const IS_PRODUCTION = isProduction()
const IS_PORTABLE = isPortable()

const UI_HEADER_HEIGHT = 38
const UI_TORRENT_HEIGHT = 100

module.exports = {
  APP_COPYRIGHT: `Copyright © 2014-${new Date().getFullYear()} ${APP_TEAM}`,
  // StreamTorrent is a modified build of WebTorrent Desktop, which is MIT
  // licensed. The notice above and the LICENSE file are kept as the licence
  // requires, and this line is shown in the About window.
  APP_BASED_ON: 'Based on WebTorrent Desktop (MIT licensed)',
  APP_FILE_ICON: path.join(ROOT_PATH, 'static', 'StreamTorrentFile'),
  APP_ICON: path.join(ROOT_PATH, 'static', 'StreamTorrent'),
  APP_NAME,
  APP_TEAM,
  // Who the Windows installer lists as the publisher. The copyright above still
  // credits the authors of the code this is built from, as the licence requires.
  APP_PUBLISHER: APP_NAME,
  APP_VERSION,
  APP_WINDOW_TITLE: APP_NAME,

  CONFIG_PATH: getConfigPath(),

  DEFAULT_TORRENTS: [],

  DELAYED_INIT: 3000 /* 3 seconds */,

  DEFAULT_DOWNLOAD_PATH: getDefaultDownloadPath(),

  // Where new builds are looked for by Help > Check for a New Build. It is
  // the folder bin/package.js writes RELEASES and the .nupkg files to, and
  // the user can point it somewhere else in Preferences.
  DEFAULT_UPDATE_FOLDER: path.join(getPath('downloads') || os.homedir(),
    'StreamTorrent', 'dist'),

  IS_PORTABLE,
  IS_PRODUCTION,
  IS_TEST,

  OS_SYSARCH: arch() === 'x64' ? 'x64' : 'ia32',

  POSTER_PATH: path.join(getConfigPath(), 'Posters'),
  ROOT_PATH,
  STATIC_PATH: path.join(ROOT_PATH, 'static'),
  TORRENT_PATH: path.join(getConfigPath(), 'Torrents'),

  // Scratch space for the files being previewed. It lives inside the program's
  // own folder (next to the executable, or in "Portable Settings" for the
  // portable build), is kept while the app is running so that replaying a file
  // is instant, and is deleted when the app starts and when it quits.
  TEMP_PATH: getTempPath(),

  // The speeds offered by the playback speed menu, and stepped through by the
  // < and > keys
  PLAYBACK_RATES: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4],

  // The bundled video engine. Shipped inside the app, so there is nothing to
  // install and nothing on the machine it could pick up instead.
  MPV_PATH: getMpvPath(),

  // The exact builds bundled, and where their source code can be obtained.
  // mpv and FFmpeg are free software; the licence texts ship in
  // static/licenses and are reachable from the About window.
  MPV_VERSION: 'v0.42.0-5-g55d3feb45',
  MPV_FFMPEG_VERSION: 'N-128607-g1ddef7d76',
  MPV_SOURCE_URL: 'https://github.com/mpv-player/mpv',
  FFMPEG_SOURCE_URL: 'https://github.com/FFmpeg/FFmpeg',
  LICENSES_PATH: path.join(ROOT_PATH, 'static', 'licenses'),

  // Subtitle files we can offer to load out of a torrent
  SUBTITLE_EXTENSIONS: ['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx'],

  // How far the subtitle timing moves per nudge, in seconds
  SUBTITLE_DELAY_STEP: 0.1,

  WINDOW_ABOUT: 'file://' + path.join(ROOT_PATH, 'static', 'about.html'),
  WINDOW_MAIN: 'file://' + path.join(ROOT_PATH, 'static', 'main.html'),
  WINDOW_WEBTORRENT: 'file://' + path.join(ROOT_PATH, 'static', 'webtorrent.html'),

  WINDOW_INITIAL_BOUNDS: {
    width: 500,
    height: UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 6) // header + 6 torrents
  },
  WINDOW_MIN_HEIGHT: UI_HEADER_HEIGHT + (UI_TORRENT_HEIGHT * 2), // header + 2 torrents
  WINDOW_MIN_WIDTH: 425,

  UI_HEADER_HEIGHT,
  UI_TORRENT_HEIGHT,

  // How tall the player's controls are, in pixels: the 38px bar at the bottom
  // plus the 6px seek bar, which sits flush along its top edge. Nothing else,
  // so no dark strip is left standing over the picture.
  UI_PLAYER_CONTROLS_HEIGHT: UI_HEADER_HEIGHT + 6,

  // How tall the label showing the time under the pointer is, with the point
  // at its bottom. It floats in a window of its own just above the seek bar,
  // so the bar itself never changes size.
  UI_PLAYER_PREVIEW_HEIGHT: 34
}

function getConfigPath () {
  if (IS_PORTABLE) {
    return PORTABLE_PATH
  }

  /**
   * Not %LOCALAPPDATA%\StreamTorrent: that is where Squirrel installs the
   * program, and StreamTorrentSetup.exe deletes that folder outright every
   * time it runs. The torrent list, the thumbnails and the saved .torrent
   * files would go with it. They live beside it instead, in a folder nothing
   * but this app touches; src/main/migrate-data.js brings across anything
   * left in the old place.
   */
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, APP_NAME + 'Data')
  }

  return path.dirname(appConfig.filePath)
}

// The folder the program itself lives in. For an installed build that is the
// folder holding the .exe; in development it is the repository.
function getProgramPath () {
  return IS_PRODUCTION ? path.dirname(process.execPath) : ROOT_PATH
}

// mpv lives in the app's resources once packaged, and in vendor/ in development
function getMpvPath () {
  const exe = process.platform === 'win32' ? 'mpv.exe' : 'mpv'
  return IS_PRODUCTION
    ? path.join(process.resourcesPath, 'mpv', exe)
    : path.join(ROOT_PATH, 'vendor', 'mpv', exe)
}

function getTempPath () {
  // The portable build keeps everything, temp files included, inside its own
  // "Portable Settings" folder so it leaves nothing behind on the machine
  if (IS_PORTABLE) return path.join(PORTABLE_PATH, 'Temp')

  // Beside the saved data, in the folder the installer never touches. The
  // program's own folder is no good: it is named after the version, and the
  // installer deletes the lot each time it runs - which it could not even do
  // while a big torrent's deep folders were sitting in there.
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(getConfigPath(), 'Temp')
  }

  return path.join(getProgramPath(), 'Temp')
}

function getDefaultDownloadPath () {
  if (IS_PORTABLE) {
    return path.join(getConfigPath(), 'Downloads')
  } else {
    return getPath('downloads')
  }
}

function getPath (key) {
  if (!process.versions.electron) {
    // Node.js process
    return ''
  } else if (process.type === 'renderer') {
    // Electron renderer process
    return require('@electron/remote').app.getPath(key)
  } else {
    // Electron main process
    return app.getPath(key)
  }
}

function isTest () {
  return process.env.NODE_ENV === 'test'
}

function isPortable () {
  if (IS_TEST) {
    return true
  }

  if (process.platform !== 'win32' || !IS_PRODUCTION) {
    // Fast path: Non-Windows platforms should not check for path on disk
    return false
  }

  const fs = require('fs')

  try {
    // This line throws if the "Portable Settings" folder does not exist, and does
    // nothing otherwise.
    fs.accessSync(PORTABLE_PATH, fs.constants.R_OK | fs.constants.W_OK)
    return true
  } catch (err) {
    return false
  }
}

function isProduction () {
  if (!process.versions.electron) {
    // Node.js process
    return false
  }
  if (process.platform === 'darwin') {
    return !/\/Electron\.app\//.test(process.execPath)
  }
  if (process.platform === 'win32') {
    return !/\\electron\.exe$/.test(process.execPath)
  }
  if (process.platform === 'linux') {
    return !/\/electron$/.test(process.execPath)
  }
}
