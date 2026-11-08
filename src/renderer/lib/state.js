const path = require('path')
const { EventEmitter } = require('events')

const config = require('../../config')
const appConfig = require('application-config')(config.APP_NAME)
const defaultAnnounceList = require('create-torrent').announceList.map((arr) => arr[0])

const SAVE_DEBOUNCE_INTERVAL = 1000

appConfig.filePath = path.join(config.CONFIG_PATH, 'config.json')

const State = module.exports = Object.assign(new EventEmitter(), {
  getDefaultPlayState,
  load,
  // state.save() calls are rate-limited. Use state.saveImmediate() to skip limit.
  save (...args) {
    // Perf optimization: Lazy-require debounce (and it's dependencies)
    const debounce = require('debounce')
    // After first State.save() invokation, future calls go straight to the
    // debounced function
    State.save = debounce(saveImmediate, SAVE_DEBOUNCE_INTERVAL)
    State.save(...args)
  },
  saveImmediate
})

function getDefaultState () {
  const LocationHistory = require('location-history')

  return {
    /*
     * Temporary state disappears once the program exits.
     * It can contain complex objects like open connections, etc.
     */
    client: null, /* the WebTorrent client */
    server: null, /* local WebTorrent-to-HTTP server */
    prev: { /* used for state diffing in updateElectron() */
      title: null,
      progress: -1,
      badge: null
    },
    location: new LocationHistory(),
    window: {
      bounds: null, /* {x, y, width, height } */
      isFocused: true,
      isFullScreen: false,
      title: config.APP_WINDOW_TITLE
    },
    selectedInfoHash: null, /* the torrent we've selected to view details. see state.torrents */
    playing: getDefaultPlayState(), /* the media (audio or video) that we're currently playing */
    devices: {}, /* playback devices like Chromecast and AppleTV */
    dock: {
      badge: 0,
      progress: 0
    },
    modal: null, /* modal popover */
    errors: [], /* user-facing errors */
    nextTorrentKey: 1, /* identify torrents for IPC between the main and webtorrent windows */
    nextStreamKey: 1, /* makes each preview use a scratch folder of its own */

    /*
     * Torrent list view state. Kept so that closing the player brings the list
     * back exactly as the user left it: same scroll position, same open folders.
     */
    listScrollTop: 0, /* scroll position of the torrent list */
    lastPlayed: null, /* {infoHash, fileIndex} of the file played most recently */
    streaming: null, /* {infoHash, fileIndex} of the file being downloaded now */
    tempPath: null, /* the temp folder actually in use, once checked */
    tempUsage: null, /* {bytes, path} for the Preferences screen */

    /*
     * Saved state is read from and written to a file every time the app runs.
     * It should be simple and minimal and must be JSON.
     * It must never contain absolute paths since we have a portable app.
     *
     * Config path:
     *
     * Mac                  ~/Library/Application Support/WebTorrent/config.json
     * Linux (XDG)          $XDG_CONFIG_HOME/WebTorrent/config.json
     * Linux (Legacy)       ~/.config/WebTorrent/config.json
     * Windows (> Vista)    %LOCALAPPDATA%/WebTorrent/config.json
     * Windows (XP, 2000)   %USERPROFILE%/Local Settings/Application Data/WebTorrent/config.json
     *
     * Also accessible via `require('application-config')('WebTorrent').filePath`
     */
    saved: {},

    /*
     * Getters, for convenience
     */
    getPlayingTorrentSummary,
    getPlayingFileSummary,
    getGlobalTrackers,
    shouldHidePlayerControls
  }
}

/* Whenever we stop playing video or audio, here's what we reset state.playing to */
function getDefaultPlayState () {
  return {
    infoHash: null, /* the info hash of the torrent we're playing */
    fileIndex: null, /* the zero-based index within the torrent */
    fileName: null, /* name of the file that is playing */
    location: 'local', /* 'local', 'chromecast', 'airplay' */
    type: null, /* 'audio', 'video' or 'image'; 'other' when streaming to VLC */
    currentTime: 0, /* seconds */
    duration: 1, /* seconds */
    isReady: false,
    imageLoaded: false, /* image viewer: has the picture itself arrived yet */
    resumedFrom: null, /* seconds we resumed from, for the "Resumed from" note */
    subtitleDelay: 0, /* subtitle timing offset, in seconds */
    isPaused: true,
    isStalled: false,
    lastTimeUpdate: 0, /* Unix time in ms */
    mouseStationarySince: 0, /* Unix time in ms */
    playbackRate: 1, /* overwritten from saved prefs when the player opens */
    showPlaybackRateMenu: false, /* the speed popover, above the video */
    volume: 1,
    subtitles: {
      tracks: [], /* subtitle tracks, each {label, language, ...} */
      selectedIndex: -1, /* current subtitle track */
      showMenu: false /* popover menu, above the video */
    },
    audioTracks: {
      tracks: [],
      selectedIndex: 0, /* current audio track */
      showMenu: false /* popover menu, above the video */
    },
    aspectRatio: 0 /* aspect ratio of the video */
  }
}

/* If the saved state file doesn't exist yet, here's what we use instead */
function setupStateSaved () {
  const { copyFileSync, mkdirSync, readFileSync } = require('fs')
  const parseTorrent = require('parse-torrent')

  const saved = {
    prefs: {
      downloadPath: config.DEFAULT_DOWNLOAD_PATH,
      isFileHandler: false,
      startup: false,
      soundNotifications: true,
      autoAddTorrents: false,
      torrentsFolderPath: '',
      highestPlaybackPriority: true,
      globalTrackers: defaultAnnounceList,
      playbackRate: 1, /* remembered between videos and app restarts */
      tempPath: '' /* '' means the default folder, inside the program folder */
    },
    torrents: config.DEFAULT_TORRENTS.map(createTorrentObject),
    folderExpanded: {}, /* which folders of which torrents are open */
    staleTempPaths: [], /* temp folders we used before the setting was changed */
    torrentsToResume: [],
    version: config.APP_VERSION /* make sure we can upgrade gracefully later */
  }

  // TODO: Doing several sync calls during first startup is not ideal
  mkdirSync(config.POSTER_PATH, { recursive: true })
  mkdirSync(config.TORRENT_PATH, { recursive: true })

  config.DEFAULT_TORRENTS.forEach((t, i) => {
    const infoHash = saved.torrents[i].infoHash
    // TODO: Doing several sync calls during first startup is not ideal
    copyFileSync(
      path.join(config.STATIC_PATH, t.posterFileName),
      path.join(config.POSTER_PATH, infoHash + path.extname(t.posterFileName))
    )
    copyFileSync(
      path.join(config.STATIC_PATH, t.torrentFileName),
      path.join(config.TORRENT_PATH, infoHash + '.torrent')
    )
  })

  return saved

  function createTorrentObject (t) {
    // TODO: Doing several sync calls during first startup is not ideal
    const torrent = readFileSync(path.join(config.STATIC_PATH, t.torrentFileName))
    const parsedTorrent = parseTorrent(torrent)

    return {
      status: 'paused',
      infoHash: parsedTorrent.infoHash,
      name: t.name,
      displayName: t.name,
      posterFileName: parsedTorrent.infoHash + path.extname(t.posterFileName),
      torrentFileName: parsedTorrent.infoHash + '.torrent',
      magnetURI: parseTorrent.toMagnetURI(parsedTorrent),
      files: parsedTorrent.files,
      // Nothing is selected by default: a file is only downloaded once the user
      // plays it. See PlaybackController.streamOnlyFile()
      selections: parsedTorrent.files.map(() => false),
      testID: t.testID
    }
  }
}

function getPlayingTorrentSummary () {
  const infoHash = this.playing.infoHash
  return this.saved.torrents.find((x) => x.infoHash === infoHash)
}

function getPlayingFileSummary () {
  const torrentSummary = this.getPlayingTorrentSummary()
  if (!torrentSummary) return null
  return torrentSummary.files[this.playing.fileIndex]
}

function shouldHidePlayerControls () {
  // The image viewer has no timeline to get out of the way of, so its controls
  // stay put
  if (this.playing.type === 'image') return false

  return this.location.url() === 'player' &&
    this.playing.mouseStationarySince !== 0 &&
    new Date().getTime() - this.playing.mouseStationarySince > 2000 &&
    !this.playing.mouseInControls &&
    !this.playing.isPaused &&
    this.playing.location === 'local'
}

function getGlobalTrackers () {
  const trackers = this.saved.prefs.globalTrackers
  if (!trackers) {
    return defaultAnnounceList
  }
  return trackers
}

async function load (cb) {
  let saved = await appConfig.read()

  if (!saved || !saved.version) {
    console.log('Missing config file: Creating new one')
    try {
      saved = setupStateSaved()
    } catch (err) {
      onSavedState(err)
      return
    }
  }

  onSavedState(null, saved)

  function onSavedState (err, saved) {
    if (err) return cb(err)
    const state = getDefaultState()
    state.saved = saved

    // Fill in anything a config written by an older build is missing, so that
    // saved torrents, open folders and the chosen speed all survive an upgrade
    if (!saved.folderExpanded) saved.folderExpanded = {}
    if (!saved.prefs) saved.prefs = {}
    if (typeof saved.prefs.playbackRate !== 'number') saved.prefs.playbackRate = 1
    if (typeof saved.prefs.tempPath !== 'string') saved.prefs.tempPath = ''
    if (!Array.isArray(saved.torrents)) saved.torrents = []
    if (!Array.isArray(saved.staleTempPaths)) saved.staleTempPaths = []

    if (process.type === 'renderer') {
      // Perf optimization: Save require() calls in the main process
      const migrations = require('./migrations')
      migrations.run(state)
    }

    cb(null, state)
  }
}

// Write state.saved to the JSON state file
async function saveImmediate (state, cb) {
  console.log('Saving state to ' + appConfig.filePath)

  // Clean up, so that we're not saving any pending state
  const copy = Object.assign({}, state.saved)
  // Remove torrents pending addition to the list, where we haven't finished
  // reading the torrent file or file(s) to seed & don't have an infohash
  copy.torrents = copy.torrents
    .filter((x) => x.infoHash)
    .map(x => {
      const torrent = {}
      for (const key in x) {
        if (key === 'progress' || key === 'torrentKey') {
          continue // Don't save progress info or key for the webtorrent process
        }
        if (key === 'error') {
          continue // Don't save error states
        }
        torrent[key] = x[key]
      }
      return torrent
    })

  try {
    await appConfig.write(copy)
    State.emit('stateSaved')
  } catch (err) {
    console.error(err)
  }
}
