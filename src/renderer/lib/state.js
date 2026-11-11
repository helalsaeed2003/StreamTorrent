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
    /* which folders of which torrents are open. Not saved: a torrent opens
       with its folders closed every time the app starts */
    folderExpanded: {},
    /* while a torrent is being dragged into a new place in the list */
    draggingTorrent: null, /* infoHash of the torrent being dragged */
    dropBefore: null, /* it would land above this one */
    dropAfter: null, /* ...or below this one */
    /* the search box over the open torrent's files, opened with Ctrl+F */
    find: { active: false, query: '', historyOpen: false },
    lastPlayed: null, /* {infoHash, fileIndex} of the file played most recently */
    streaming: null, /* {infoHash, fileIndex} of the file being downloaded now */
    tempPath: null, /* the temp folder actually in use, once checked */
    tempUsage: null, /* {bytes, path} for the Preferences screen */
    /* infoHashes of torrents kept awake while a poster frame is taken */
    postersInFlight: new Set(),
    /*
     * Files the user asked for ahead of watching them: a Map of infoHash to
     * a Set of file indexes. It is not saved, because the files themselves
     * are thrown away when the app quits.
     */
    preloads: new Map(),

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
    resumeOffer: null, /* seconds we could jump to, offered when a video opens */
    resumeOfferedAt: 0, /* when that offer was made, so it can time out */
    subtitleDelay: 0, /* subtitle timing offset, in seconds */
    isPaused: true,
    isStalled: false,
    lastTimeUpdate: 0, /* Unix time in ms */
    mouseStationarySince: 0, /* Unix time in ms */
    playbackRate: 1, /* back to normal speed for every video */
    /* which menu is up: 'speed', 'subtitles', 'audio' or null. They are drawn
       in a window of their own, over the video */
    openMenu: null,
    volume: 1,
    subtitles: {
      tracks: [], /* subtitle tracks, each {label, language, ...} */
      selectedIndex: -1 /* current subtitle track */
    },
    audioTracks: {
      tracks: [],
      selectedIndex: 0 /* current audio track */
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
      tempPath: '', /* '' means the default folder, inside the program folder */
      playlistFollowsSearch: true, /* Next and Previous follow an open search */
      searchHistory: true /* the search box remembers and offers what was typed */
    },
    torrents: config.DEFAULT_TORRENTS.map(createTorrentObject),
    searchHistory: [], /* what was last searched for, newest first */
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

  // A menu is up, and it hangs off the controls
  if (this.playing.openMenu) return false

  return this.location.url() === 'player' &&
    this.playing.mouseStationarySince !== 0 &&
    new Date().getTime() - this.playing.mouseStationarySince > 1200 &&
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
    // Open folders used to be saved. They are not any more, so a torrent
    // opens closed up however it was left, and the old entries are dropped
    delete saved.folderExpanded
    if (!saved.prefs) saved.prefs = {}
    if (typeof saved.prefs.tempPath !== 'string') saved.prefs.tempPath = ''
    if (typeof saved.prefs.updateFolder !== 'string') {
      saved.prefs.updateFolder = config.DEFAULT_UPDATE_FOLDER
    }
    if (!Array.isArray(saved.torrents)) saved.torrents = []
    if (!Array.isArray(saved.staleTempPaths)) saved.staleTempPaths = []

    // A torrent whose .torrent file is still here but which the saved list
    // has lost - to a crash, or an update that cut the app off - is put back
    recoverLostTorrents(saved)

    // Everything downloaded is deleted when the app quits, so nothing is
    // wanted from a torrent until the user plays or preloads something.
    // Without this, files chosen last time would start downloading again.
    saved.torrents.forEach(torrent => {
      if (Array.isArray(torrent.selections)) {
        torrent.selections = torrent.selections.map(() => false)
      }
    })

    if (process.type === 'renderer') {
      // Perf optimization: Save require() calls in the main process
      const migrations = require('./migrations')
      migrations.run(state)
    }

    cb(null, state)
  }
}

/**
 * Puts back any torrent whose .torrent file is still in the torrents folder
 * but which is missing from the saved list.
 *
 * Every torrent added is written there, and the file is deleted when the user
 * removes the torrent, so anything left over is a torrent that was added and
 * never removed. Without this, a state file lost to a crash or an update takes
 * the whole list with it even though the torrents themselves are still here.
 */
function recoverLostTorrents (saved) {
  const fs = require('fs')
  const parseTorrent = require('parse-torrent')

  let names
  try {
    names = fs.readdirSync(config.TORRENT_PATH)
  } catch (err) {
    return // no folder yet: nothing was ever added
  }

  const known = new Set(saved.torrents.map(t => t.infoHash).filter(Boolean))

  for (const name of names) {
    if (!name.endsWith('.torrent')) continue
    const infoHash = path.basename(name, '.torrent')
    if (known.has(infoHash)) continue

    let parsed
    try {
      parsed = parseTorrent(fs.readFileSync(path.join(config.TORRENT_PATH, name)))
    } catch (err) {
      console.log('could not read the torrent file %s: %o', name, err)
      continue
    }
    if (!parsed || parsed.infoHash !== infoHash) continue

    const poster = findPoster(infoHash)
    saved.torrents.push({
      status: 'paused',
      infoHash,
      name: parsed.name,
      displayName: parsed.name,
      torrentFileName: name,
      magnetURI: parseTorrent.toMagnetURI(parsed),
      files: parsed.files,
      // Nothing is downloaded until the user plays or preloads something
      selections: parsed.files.map(() => false),
      posterFileName: poster || undefined
    })
    console.log('put %s back in the list from its torrent file', parsed.name)
  }
}

// The thumbnail already taken for a torrent, if there is one
function findPoster (infoHash) {
  const fs = require('fs')
  for (const extension of ['.jpg', '.png', '.gif']) {
    try {
      const name = infoHash + extension
      fs.statSync(path.join(config.POSTER_PATH, name))
      return name
    } catch (err) {}
  }
  return null
}

/**
 * Writes the torrent list, the preferences and where each video was left off
 * to the state file.
 *
 * Written here rather than through application-config: the file is written to
 * a temporary name alongside it and then renamed over the old one, so a crash
 * or a power cut in the middle leaves the last good copy in place. A failure
 * is shouted about rather than passed over, since losing this file means
 * losing the torrent list.
 */
function saveImmediate (state, cb) {
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

  const fs = require('fs')
  const file = appConfig.filePath
  const temporary = file + '.writing'

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify(copy, null, 2))
    fs.renameSync(temporary, file)
  } catch (err) {
    console.error('Could not save the state file ' + file, err)
    try {
      fs.rmSync(temporary, { force: true })
    } catch (ignored) {}
  }

  // Said either way: whoever is waiting to quit should not be left hanging
  State.emit('stateSaved')
  if (cb) cb()
}
