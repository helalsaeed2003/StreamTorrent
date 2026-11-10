/**
 * Perf optimization: Hook into require() to modify how certain modules load:
 *
 * - `inline-style-prefixer` (used by `material-ui`) takes ~40ms. It is not
 *   actually used because auto-prefixing is disabled with
 *   `darkBaseTheme.userAgent = false`. Return a fake object.
 */
const Module = require('module')
const _require = Module.prototype.require
Module.prototype.require = function (id) {
  if (id === 'inline-style-prefixer') return {}
  return _require.apply(this, arguments)
}

console.time('init')

// Perf optimization: Start asynchronously read on config file before all the
// blocking require() calls below.

const State = require('./lib/state')
State.load(onState)

const createGetter = require('fn-getter')
const dragDrop = require('drag-drop')
const electron = require('electron')
// Electron removed the built-in `remote` module, so `electron.remote` is
// undefined and reading it threw on startup and whenever a video loaded.
// The rest of the app already uses @electron/remote; use it here too.
const remote = require('@electron/remote')
const React = require('react')
const ReactDOM = require('react-dom')

const config = require('../config')
const telemetry = require('./lib/telemetry')
const sound = require('./lib/sound')
const TorrentPlayer = require('./lib/torrent-player')
const MpvPlayer = require('./lib/mpv-player')
const PlayerMenu = require('./lib/player-menu')
const { showContextMenu } = require('./lib/context-menu')

// Perf optimization: Needed immediately, so do not lazy load it below
const TorrentListController = require('./controllers/torrent-list-controller')

const App = require('./pages/app')

// Electron apps have two processes: a main process (node) runs first and starts
// a renderer process (essentially a Chrome window). We're in the renderer process,
// and this IPC channel receives from and sends messages to the main process
const ipcRenderer = electron.ipcRenderer

// Yo-yo pattern: state object lives here and percolates down thru all the views.
// Events come back up from the views via dispatch(...)
require('./lib/dispatcher').setDispatch(dispatch)

// From dispatch(...), events are sent to one of the controllers
let controllers = null

// This dependency is the slowest-loading, so we lazy load it
let Cast = null

// All state lives in state.js. `state.saved` is read from and written to a file.
// All other state is ephemeral. First we load state.saved then initialize the app.
let state

// Root React component
let app

// Called once when the application loads. (Not once per window.)
// Connects to the torrent networks, sets up the UI and OS integrations like
// the dock icon and drag+drop.
function onState (err, _state) {
  if (err) return onError(err)

  // Make available for easier debugging
  state = window.state = _state
  window.dispatch = dispatch

  telemetry.init(state)
  sound.init(state)
  MpvPlayer.init(state, update)

  // Log uncaught JS errors
  window.addEventListener(
    'error', (e) => telemetry.logUncaughtError('window', e), true /* capture */
  )

  // Create controllers
  controllers = {
    media: createGetter(() => {
      const MediaController = require('./controllers/media-controller')
      return new MediaController(state)
    }),
    playback: createGetter(() => {
      const PlaybackController = require('./controllers/playback-controller')
      return new PlaybackController(state, config, update)
    }),
    prefs: createGetter(() => {
      const PrefsController = require('./controllers/prefs-controller')
      return new PrefsController(state, config)
    }),
    subtitles: createGetter(() => {
      const SubtitlesController = require('./controllers/subtitles-controller')
      return new SubtitlesController(state)
    }),
    audioTracks: createGetter(() => {
      const AudioTracksController = require('./controllers/audio-tracks-controller')
      return new AudioTracksController(state)
    }),
    torrent: createGetter(() => {
      const TorrentController = require('./controllers/torrent-controller')
      return new TorrentController(state)
    }),
    torrentList: createGetter(() => new TorrentListController(state)),
    update: createGetter(() => {
      const UpdateController = require('./controllers/update-controller')
      return new UpdateController(state)
    }),
    folderWatcher: createGetter(() => {
      const FolderWatcherController = require('./controllers/folder-watcher-controller')
      return new FolderWatcherController()
    })
  }

  // Add first page to location history
  state.location.go({
    url: 'home',
    setup: (cb) => {
      state.window.title = config.APP_WINDOW_TITLE
      cb(null)
    }
  })

  // Give global trackers
  setGlobalTrackers()

  // Work out where temporary files go, and make sure we can write there
  controllers.prefs().applyTempPath()

  // Throw away anything a previous run left in the temp folder
  ipcRenderer.send('wt-wipe-temp')

  // Hand out torrent keys, and fetch metadata for torrents we don't know yet
  resumeTorrents()

  // Initialize ReactDOM
  ReactDOM.render(
    <App state={state} ref={elem => { app = elem }} />,
    document.querySelector('#body')
  )

  // Calling update() updates the UI given the current state
  // Do this at least once a second to give every file in every torrentSummary
  // a progress bar and to keep the cursor in sync when playing a video
  setInterval(update, 1000)

  // The torrent list and where each video was left off are written out every
  // half minute. Waiting for the app to quit is not enough: an update, which
  // closes the app from outside, a crash or a power cut would take the lot.
  setInterval(() => dispatch('stateSave'), 30 * 1000)

  // Listen for messages from the main process
  setupIpc()

  // Drag and drop files/text to start torrenting or seeding
  dragDrop('body', {
    onDrop: onOpen,
    onDropText: onOpen
  })

  // ...same thing if you paste a torrent
  document.addEventListener('paste', onPaste)

  // Add YouTube style hotkey shortcuts
  window.addEventListener('keydown', onKeydown)

  // Clicking anywhere puts the player's menus away
  document.addEventListener('click', onDocumentClick, true)

  document.addEventListener('wheel', event => {
    // ctrlKey detects pinch to zoom, http://crbug.com/289887.
    // Swallow it so the page doesn't zoom, but don't toggle full screen: it
    // fired by accident far too easily. Use the full screen button or F.
    if (event.ctrlKey) event.preventDefault()
  })

  // ...focus and blur. Needed to show correct dock icon text ('badge') in OSX
  window.addEventListener('focus', onFocus)
  window.addEventListener('blur', onBlur)

  if (remote.getCurrentWindow().isVisible()) {
    sound.play('STARTUP')
  }

  // To keep app startup fast, some code is delayed.
  window.setTimeout(delayedInit, config.DELAYED_INIT)

  // Done! Ideally we want to get here < 500ms after the user clicks the app
  console.timeEnd('init')
}

// Runs a few seconds after the app loads, to avoid slowing down startup time
function delayedInit () {
  telemetry.send(state)

  // Send telemetry data every 12 hours, for users who keep the app running
  // for extended periods of time
  setInterval(() => telemetry.send(state), 12 * 3600 * 1000)

  // ...window visibility state.
  document.addEventListener('webkitvisibilitychange', onVisibilityChange)
  onVisibilityChange()

  lazyLoadCast()
}

// Lazily loads Chromecast and Airplay support
function lazyLoadCast () {
  if (!Cast) {
    Cast = require('./lib/cast')
    Cast.init(state, update) // Search the local network for Chromecast and Airplays
  }
  return Cast
}

// React loop:
// 1. update() - recompute the virtual DOM, diff, apply to the real DOM
// 2. event - might be a click or other DOM event, or something external
// 3. dispatch - the event handler calls dispatch(), main.js sends it to a controller
// 4. controller - the controller handles the event, changing the state object
function update () {
  controllers.playback().showOrHidePlayerControls()

  // React drops the ref if a render throws, and update() runs on a timer, so
  // without this one bad render would leave the app throwing here every second
  // with a dead window. Skip the repaint instead and let the next one recover.
  if (app) app.setState(state)

  // The video area grows and shrinks as the controls hide and show, and as
  // menus open over the video, and mpv draws in a window of its own, so it
  // has to be told. This runs after the repaint, since it measures what the
  // page has just drawn, and every time round rather than only when the
  // controls change, because dispatch() consumes that change before this
  // point when the mouse is what moved.
  MpvPlayer.updateInsets(state)

  // The speed, subtitle and audio menus are drawn in a window of their own,
  // over the video, so they are told from here what to show
  PlayerMenu.sync(state)
  updateElectron()
}

// Some state changes can't be reflected in the DOM, instead we have to
// tell the main process to update the window or OS integrations
function updateElectron () {
  if (state.window.title !== state.prev.title) {
    state.prev.title = state.window.title
    ipcRenderer.send('setTitle', state.window.title)
  }
  if (state.dock.progress.toFixed(2) !== state.prev.progress.toFixed(2)) {
    state.prev.progress = state.dock.progress
    ipcRenderer.send('setProgress', state.dock.progress)
  }
  if (state.dock.badge !== state.prev.badge) {
    state.prev.badge = state.dock.badge
    ipcRenderer.send('setBadge', state.dock.badge || 0)
  }
}

const dispatchHandlers = {
  // Torrent list: creating, deleting, selecting torrents
  openTorrentFile: () => ipcRenderer.send('openTorrentFile'),
  openFiles: () => ipcRenderer.send('openFiles'), /* shows the open file dialog */
  openTorrentAddress: () => { state.modal = { id: 'open-torrent-address-modal' } },

  addTorrent: (torrentId) => controllers.torrentList().addTorrent(torrentId),
  showCreateTorrent: (paths) => controllers.torrentList().showCreateTorrent(paths),
  createTorrent: (options) => controllers.torrentList().createTorrent(options),
  toggleTorrent: (infoHash) => controllers.torrentList().toggleTorrent(infoHash),
  pauseAllTorrents: () => controllers.torrentList().pauseAllTorrents(),
  resumeAllTorrents: () => controllers.torrentList().resumeAllTorrents(),
  togglePreloadFile: (infoHash, index) =>
    controllers.torrentList().togglePreloadFile(infoHash, index),
  togglePreloadFolder: (infoHash, indexes) =>
    controllers.torrentList().togglePreloadFolder(infoHash, indexes),
  toggleTorrentFile: (infoHash, index) =>
    controllers.torrentList().toggleTorrentFile(infoHash, index),
  confirmDeleteTorrent: (infoHash, deleteData) =>
    controllers.torrentList().confirmDeleteTorrent(infoHash, deleteData),
  deleteTorrent: (infoHash, deleteData) =>
    controllers.torrentList().deleteTorrent(infoHash, deleteData),
  openTorrentListContextMenu: () =>
    controllers.torrentList().openTorrentListContextMenu(),
  showTorrentInFolder: (infoHash) =>
    controllers.torrentList().showTorrentInFolder(infoHash),
  copyToClipboard: (text) => electron.clipboard.writeText(text),
  confirmDeleteAllTorrents: (deleteData) =>
    controllers.torrentList().confirmDeleteAllTorrents(deleteData),
  deleteAllTorrents: (deleteData) =>
    controllers.torrentList().deleteAllTorrents(deleteData),
  toggleFind: () => {
    // Only worth anything while a torrent is open: it searches that torrent
    if (!state.selectedInfoHash) return
    state.find.active = !state.find.active
    if (!state.find.active) state.find.query = ''
  },
  setFindQuery: (query) => { state.find.query = query },
  openTextContextMenu: () => showContextMenu([
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { type: 'separator' },
    { role: 'delete' },
    { role: 'selectAll' }
  ]),
  closeFind: () => {
    state.find.active = false
    state.find.query = ''
  },
  toggleSelectTorrent: (infoHash) =>
    controllers.torrentList().toggleSelectTorrent(infoHash),
  toggleFolder: (infoHash, folderKey) =>
    controllers.torrentList().toggleFolder(infoHash, folderKey),
  setAllFoldersExpanded: (infoHash, expanded) =>
    controllers.torrentList().setAllFoldersExpanded(infoHash, expanded),
  idleTorrent: (infoHash) => controllers.torrentList().idleTorrent(infoHash),
  openTorrentContextMenu: (infoHash) =>
    controllers.torrentList().openTorrentContextMenu(infoHash),
  startTorrentingSummary: (torrentKey) =>
    controllers.torrentList().startTorrentingSummary(torrentKey),
  saveTorrentFileAs: (torrentKey) =>
    controllers.torrentList().saveTorrentFileAs(torrentKey),
  prioritizeTorrent: (infoHash) => controllers.torrentList().prioritizeTorrent(infoHash),
  resumePausedTorrents: () => controllers.torrentList().resumePausedTorrents(),

  // Playback
  playFile: (infoHash, index) => controllers.playback().playFile(infoHash, index),
  playPause: () => controllers.playback().playPause(),
  nextTrack: () => controllers.playback().nextTrack(),
  previousTrack: () => controllers.playback().previousTrack(),
  skip: (time) => controllers.playback().skip(time),
  skipTo: (time) => controllers.playback().skipTo(time),
  preview: (x) => controllers.playback().preview(x),
  clearPreview: () => controllers.playback().clearPreview(),
  changePlaybackRate: (dir) => controllers.playback().changePlaybackRate(dir),
  savePosition: () => controllers.playback().savePosition(),
  mediaEnded: () => controllers.playback().mediaEnded(),
  mpvReady: () => controllers.playback().mpvReady(),
  mpvEnded: () => controllers.playback().mpvEnded(),
  mpvMaybeLoad: () => controllers.playback().loadIntoMpv(),
  startOver: () => controllers.playback().startOver(),
  dismissResumeNote: () => controllers.playback().dismissResumeNote(),
  clearFileProgress: (infoHash, index) =>
    controllers.torrentList().clearFileProgress(infoHash, index),
  toggleFileWatched: (infoHash, index) =>
    controllers.torrentList().toggleFileWatched(infoHash, index),
  openFileContextMenu: (infoHash, index) =>
    controllers.torrentList().openFileContextMenu(infoHash, index),
  setPlaybackRate: (rate) => controllers.playback().setPlaybackRate(rate),
  togglePlaybackRateMenu: () => controllers.playback().togglePlaybackRateMenu(),
  changeVolume: (delta) => controllers.playback().changeVolume(delta),
  setVolume: (vol) => controllers.playback().setVolume(vol),
  openPath: (infoHash, index) => controllers.playback().openPath(infoHash, index),

  // Subtitles
  openSubtitles: () => controllers.subtitles().openSubtitles(),
  selectSubtitle: (index) => controllers.subtitles().selectSubtitle(index),
  selectTorrentSubtitle: (index) => controllers.subtitles().selectTorrentSubtitle(index),
  toggleSubtitlesMenu: () => controllers.subtitles().toggleSubtitlesMenu(),
  checkForSubtitles: () => controllers.subtitles().checkForSubtitles(),
  addSubtitles: (files, autoSelect) => controllers.subtitles().addSubtitles(files, autoSelect),
  changeSubtitleDelay: (dir) => controllers.subtitles().changeSubtitleDelay(dir),
  setSubtitleDelay: (seconds) => controllers.subtitles().setSubtitleDelay(seconds),
  resetSubtitleDelay: () => controllers.subtitles().setSubtitleDelay(0),
  changeSubtitleScale: (dir) => controllers.subtitles().changeSubtitleScale(dir),
  setSubtitleScale: (scale) => controllers.subtitles().setSubtitleScale(scale),

  // Audio Tracks
  selectAudioTrack: (index) => controllers.audioTracks().selectAudioTrack(index),
  toggleAudioTracksMenu: () => controllers.audioTracks().toggleAudioTracksMenu(),

  // Local media: <video>, <audio>, external players
  mediaStalled: () => controllers.media().mediaStalled(),
  mediaError: (err) => controllers.media().mediaError(err),
  mediaSuccess: () => controllers.media().mediaSuccess(),
  mediaTimeUpdate: () => controllers.media().mediaTimeUpdate(),
  mediaMouseMoved: () => controllers.media().mediaMouseMoved(),
  mediaControlsMouseEnter: () => controllers.media().controlsMouseEnter(),
  mediaControlsMouseLeave: () => controllers.media().controlsMouseLeave(),

  // Image viewer
  imageLoaded: () => controllers.media().imageLoaded(),
  imageError: () => controllers.media().imageError(),

  // Remote casting: Chromecast, Airplay, etc
  toggleCastMenu: (deviceType) => lazyLoadCast().toggleMenu(deviceType),
  selectCastDevice: (index) => lazyLoadCast().selectDevice(index),
  stopCasting: () => lazyLoadCast().stop(),

  // Preferences screen
  preferences: () => controllers.prefs().show(),
  updatePreferences: (key, value) => controllers.prefs().update(key, value),
  resetTempFolder: () => controllers.prefs().resetTempFolder(),
  refreshTempUsage: () => controllers.prefs().refreshTempUsage(),
  clearTempNow: () => controllers.prefs().clearTempNow(),
  stopDownloading: () => controllers.playback().stopDownloading(),
  updateGlobalTrackers: (trackers) => setGlobalTrackers(trackers),
  startFolderWatcher: () => controllers.folderWatcher().start(),
  stopFolderWatcher: () => controllers.folderWatcher().stop(),

  // Update (check for new versions on Linux, where there's no auto updater)
  updateAvailable: (version) => controllers.update().updateAvailable(version),
  skipVersion: (version) => controllers.update().skipVersion(version),

  // Navigation between screens (back, ESC, etc). There is no forward: the
  // only way back is out of a video or out of Preferences.
  exitModal: () => { state.modal = null },
  backToList,
  escapeBack,
  back: () => state.location.back(),
  cancel: () => state.location.cancel(),

  // Controlling the window
  setDimensions,
  toggleFullScreen: (setTo) => ipcRenderer.send('toggleFullScreen', setTo),
  setTitle: (title) => { state.window.title = title },
  resetTitle: () => { state.window.title = config.APP_WINDOW_TITLE },

  // Everything else
  onOpen,
  error: onError,
  uncaughtError: (proc, err) => telemetry.logUncaughtError(proc, err),
  stateSave: () => State.save(state),
  stateSaveImmediate: () => {
    // Quitting mid-video still records where we got to
    if (state.location.url() === 'player') controllers.playback().savePosition()
    State.saveImmediate(state)
  },
  update: () => {} // No-op, just trigger an update
}

// Events from the UI never modify state directly. Instead they call dispatch()
function dispatch (action, ...args) {
  // Log dispatch calls, for debugging, but don't spam
  if (!['mediaMouseMoved', 'mediaTimeUpdate', 'update'].includes(action)) {
    console.log('dispatch: %s %o', action, args)
  }

  const handler = dispatchHandlers[action]
  if (handler) handler(...args)
  else console.error('Missing dispatch handler: ' + action)

  // Update the virtual DOM, unless it's just a mouse move event
  if (action !== 'mediaMouseMoved' ||
      controllers.playback().showOrHidePlayerControls()) {
    update()
  }
}

// Listen to events from the main and webtorrent processes
function setupIpc () {
  ipcRenderer.on('log', (e, ...args) => console.log(...args))
  ipcRenderer.on('error', (e, ...args) => console.error(...args))

  ipcRenderer.on('dispatch', (e, ...args) => dispatch(...args))

  ipcRenderer.on('fullscreenChanged', onFullscreenChanged)
  ipcRenderer.on('windowBoundsChanged', onWindowBoundsChanged)

  const tc = controllers.torrent()
  ipcRenderer.on('wt-parsed', (e, ...args) => tc.torrentParsed(...args))
  ipcRenderer.on('wt-metadata', (e, ...args) => tc.torrentMetadata(...args))
  ipcRenderer.on('wt-done', (e, ...args) => tc.torrentDone(...args))
  ipcRenderer.on('wt-done', () => controllers.torrentList().resumePausedTorrents())
  ipcRenderer.on('wt-warning', (e, ...args) => tc.torrentWarning(...args))
  ipcRenderer.on('wt-error', (e, ...args) => tc.torrentError(...args))

  ipcRenderer.on('wt-progress', (e, ...args) => tc.torrentProgress(...args))
  ipcRenderer.on('wt-file-modtimes', (e, ...args) => tc.torrentFileModtimes(...args))
  ipcRenderer.on('wt-file-saved', (e, ...args) => tc.torrentFileSaved(...args))
  ipcRenderer.on('wt-poster', (e, ...args) => tc.torrentPosterSaved(...args))

  // The player's menu window closed itself, because the app lost focus
  ipcRenderer.on('player-menu-closed', () => {
    if (!state.playing.openMenu) return
    state.playing.openMenu = null
    update()
  })
  ipcRenderer.on('wt-audio-metadata', (e, ...args) => tc.torrentAudioMetadata(...args))
  ipcRenderer.on('wt-server-running', (e, ...args) => tc.torrentServerRunning(...args))
  ipcRenderer.on('wt-file-ready', (e, ...args) =>
    controllers.subtitles().subtitleFileReady(...args))

  ipcRenderer.on('wt-uncaught-error', (e, err) => telemetry.logUncaughtError('webtorrent', err))

  ipcRenderer.send('ipcReady')

  State.on('stateSaved', () => ipcRenderer.send('stateSaved'))
}

// Quits any modal popovers and returns to the torrent list screen
function backToList () {
  // Exit any modals and screens with a back button
  state.modal = null
  state.location.backToFirst(() => {
    // If we were already on the torrent list, scroll to the top
    const contentTag = document.querySelector('.content')
    if (contentTag) contentTag.scrollTop = 0
  })
}

// Quits modals, full screen, or goes back. Happens when the user hits ESC
function escapeBack () {
  if (state.find.active) {
    dispatch('closeFind')
  } else if (state.modal) {
    dispatch('exitModal')
  } else if (state.window.isFullScreen) {
    dispatch('toggleFullScreen')
  } else {
    dispatch('back')
  }
}

function setGlobalTrackers () {
  controllers.torrentList().setGlobalTrackers(state.getGlobalTrackers())
}

// Called on program startup.
// Nothing is downloaded unless the user plays it, so no torrent is resumed:
// they all start out asleep and wake up when a file is played. The exception is
// a torrent whose file list we never got - that one is started just long enough
// to fetch its metadata, which downloads no file data.
function resumeTorrents () {
  state.saved.torrents
    .map((torrentSummary) => {
      // Torrent keys are ephemeral, reassigned each time the app runs.
      // On startup, give all torrents a key, even the ones that are paused.
      torrentSummary.torrentKey = state.nextTorrentKey++
      return torrentSummary
    })
    .forEach((s) => {
      // Last run's progress and errors mean nothing: the data is gone
      delete s.progress
      delete s.error

      // Clear any file selections left over from an earlier run, or from a
      // version of the app that downloaded whole torrents. Nothing is fetched
      // until the user plays something.
      if (s.files) s.selections = s.files.map(() => false)
      else delete s.selections

      const needsMetadata = !s.files || s.files.length === 0
      s.status = needsMetadata ? 'new' : 'paused'
      if (needsMetadata) controllers.torrentList().startTorrentingSummary(s.torrentKey)
    })
}

// Set window dimensions to match video dimensions or fill the screen
function setDimensions (dimensions) {
  // Don't modify the window size if it's already maximized
  if (remote.getCurrentWindow().isMaximized()) {
    state.window.bounds = null
    return
  }

  // Save the bounds of the window for later. See restoreBounds()
  state.window.bounds = {
    x: window.screenX,
    y: window.screenY,
    width: window.outerWidth,
    height: window.outerHeight
  }
  state.window.wasMaximized = remote.getCurrentWindow().isMaximized()

  // Limit window size to screen size
  const screenWidth = window.screen.width
  const screenHeight = window.screen.height
  const aspectRatio = dimensions.width / dimensions.height
  const scaleFactor = Math.min(
    Math.min(screenWidth / dimensions.width, 1),
    Math.min(screenHeight / dimensions.height, 1)
  )
  const width = Math.max(
    Math.floor(dimensions.width * scaleFactor),
    config.WINDOW_MIN_WIDTH
  )
  const height = Math.max(
    Math.floor(dimensions.height * scaleFactor),
    config.WINDOW_MIN_HEIGHT
  )

  ipcRenderer.send('setAspectRatio', aspectRatio)
  ipcRenderer.send('setBounds', { contentBounds: true, x: null, y: null, width, height })
  state.playing.aspectRatio = aspectRatio
}

// Called when the user adds files (.torrent, files to seed, subtitles) to the app
// via any method (drag-drop, drag to app icon, command line)
function onOpen (files) {
  if (!Array.isArray(files)) files = [files]

  // File API seems to transform "magnet:?foo" in "magnet:///?foo"
  // this is a sanitization
  files = files.map(file => {
    if (typeof file !== 'string') return file
    return file.replace(/^magnet:\/+\?/i, 'magnet:?')
  })

  const url = state.location.url()
  const allTorrents = files.every(TorrentPlayer.isTorrent)
  const allSubtitles = files.every(controllers.subtitles().isSubtitle)

  if (allTorrents) {
    // Drop torrents onto the app: go to home screen, add torrents, no matter what
    dispatch('backToList')
    // All .torrent files? Add them.
    files.forEach((file) => controllers.torrentList().addTorrent(file))
  } else if (url === 'player' && allSubtitles) {
    // Drop subtitles onto a playing video: add subtitles
    controllers.subtitles().addSubtitles(files, true)
  } else if (url === 'home') {
    // Drop files onto home screen: show Create Torrent
    state.modal = null
    controllers.torrentList().showCreateTorrent(files)
  } else {
    // Drop files onto any other screen: show error
    return onError('Please go back to the torrent list before creating a new torrent.')
  }

  update()
}

function onError (err) {
  console.error(err.stack || err)
  sound.play('ERROR')
  state.errors.push({
    time: new Date().getTime(),
    message: err.message || err
  })

  update()
}

const editableHtmlTags = new Set(['input', 'textarea'])

function onPaste (e) {
  if (e && editableHtmlTags.has(e.target.tagName.toLowerCase())) return
  controllers.torrentList().addTorrent(electron.clipboard.readText())

  update()
}

/**
 * A click anywhere closes an open menu, and is swallowed: clicking the
 * picture to put a menu away should not also pause the video.
 *
 * The buttons that open the menus are in the controls, so clicks there are
 * left alone and go on toggling as they should.
 */
function onDocumentClick (e) {
  const anyMenu = state.playing.openMenu || state.devices.castMenu
  if (!anyMenu) return
  if (e.target.closest && e.target.closest('.player .controls')) return

  e.preventDefault()
  e.stopPropagation()
  state.playing.openMenu = null
  state.devices.castMenu = null
  update()
}

function onKeydown (e) {
  const key = e.key

  // Ctrl+F searches the open torrent. It works from inside the search box
  // too, where it closes it again.
  if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'f') {
    e.preventDefault()
    dispatch('toggleFind')
    update()
    return
  }

  // prevent event fire on user input elements
  if (editableHtmlTags.has(e.target.tagName.toLowerCase())) return

  // In the image viewer, the arrow keys step through the images in the folder
  if (state.location.url() === 'player' && state.playing.type === 'image') {
    if (key === 'ArrowLeft') dispatch('previousTrack')
    else if (key === 'ArrowRight') dispatch('nextTrack')
    update()
    return
  }

  if (key === 'ArrowLeft') {
    dispatch('skip', -5)
  } else if (key === 'ArrowRight') {
    dispatch('skip', 5)
  } else if (key === 'ArrowUp') {
    dispatch('changeVolume', 0.1)
  } else if (key === 'ArrowDown') {
    dispatch('changeVolume', -0.1)
  } else if (key === 'j') {
    dispatch('skip', -10)
  } else if (key === 'l') {
    dispatch('skip', 10)
  } else if (key === 'k') {
    dispatch('playPause')
  } else if (key === '>') {
    dispatch('changePlaybackRate', 1)
  } else if (key === '<') {
    dispatch('changePlaybackRate', -1)
  } else if (key === 'f') {
    dispatch('toggleFullScreen')
  }

  update()
}

function onFocus (e) {
  state.window.isFocused = true
  state.dock.badge = 0
  update()
}

function onBlur () {
  state.window.isFocused = false
  update()
}

function onVisibilityChange () {
  state.window.isVisible = !document.hidden
}

function onFullscreenChanged (e, isFullScreen) {
  state.window.isFullScreen = isFullScreen
  if (!isFullScreen) {
    // Aspect ratio gets reset in fullscreen mode, so restore it (Mac)
    ipcRenderer.send('setAspectRatio', state.playing.aspectRatio)
  }

  update()
}

function onWindowBoundsChanged (e, newBounds) {
  if (state.location.url() !== 'player') {
    state.saved.bounds = newBounds
    dispatch('stateSave')
  }
}
