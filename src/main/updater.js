/**
 * Keeping the app up to date.
 *
 * The installed app looks at this project's own GitHub releases, fetches a
 * newer one quietly in the background, and then offers to restart into it.
 * Nothing else is contacted: there is no telemetry and no announcement check,
 * and the only address involved is the repository named in
 * electron-builder.yml, which electron-updater reads from app-update.yml
 * inside the packaged app.
 *
 * It never interrupts a video. If something is playing when an update lands,
 * the offer waits until playback stops.
 *
 * The portable build cannot replace itself - it is a folder the user unzipped
 * wherever they like - so it only says that a newer version is out and opens
 * the releases page.
 */

module.exports = {
  init,
  checkForUpdates,
  setPlaying
}

const { app, dialog, shell } = require('electron')

const config = require('../config')
const log = require('./log')
const windows = require('./windows')

// How long after startup the first check happens. Starting up is busy enough.
const FIRST_CHECK_MS = 30 * 1000

// And how often after that, for an app left running for days
const EVERY_MS = 4 * 60 * 60 * 1000

const RELEASES_URL =
  'https://github.com/helalsaeed2003/StreamTorrent/releases/latest'

// Set from the player, so an update never cuts a video short
let playing = false

// An update that has been fetched and is waiting for a good moment
let waiting = null

// Whether the user asked for this check, in which case they are told the
// answer either way rather than only when there is news
let asked = false

function init () {
  if (!config.IS_PRODUCTION) {
    log('updates: not checking, this is not a built copy')
    return
  }

  if (config.IS_PORTABLE) {
    log('updates: portable build, will only say when a new one is out')
  }

  setTimeout(() => checkForUpdates({ silent: true }), FIRST_CHECK_MS)
  setInterval(() => checkForUpdates({ silent: true }), EVERY_MS)
}

/** The player tells us, so that an update never interrupts anything. */
function setPlaying (isPlaying) {
  playing = !!isPlaying
  // Something was waiting for the video to end
  if (!playing && waiting) offerRestart()
}

function checkForUpdates ({ silent = false } = {}) {
  asked = !silent

  if (!config.IS_PRODUCTION) {
    if (!silent) say('Updates only work in the installed app.')
    return
  }

  // Already fetched and waiting? Then asking again just brings the offer back
  if (waiting) return offerRestart()

  const updater = get()
  if (!updater) return

  updater.checkForUpdates().catch(err => {
    log('updates: could not check - ' + err.message)
    if (asked) say('Could not check for updates.\n\n' + err.message)
  })
}

let autoUpdater = null

function get () {
  if (autoUpdater) return autoUpdater

  try {
    ({ autoUpdater } = require('electron-updater'))
  } catch (err) {
    log('updates: electron-updater is not available - ' + err.message)
    return null
  }

  autoUpdater.logger = {
    info: m => log('updates: ' + m),
    warn: m => log('updates: ' + m),
    error: m => log('updates: ' + m),
    debug: () => {}
  }

  // The portable build cannot replace itself, so it only looks
  autoUpdater.autoDownload = !config.IS_PORTABLE
  autoUpdater.autoInstallOnAppQuit = !config.IS_PORTABLE

  autoUpdater.on('update-available', info => {
    log('updates: ' + info.version + ' is out, this is ' + app.getVersion())
    if (config.IS_PORTABLE) offerDownload(info.version)
  })

  autoUpdater.on('update-not-available', () => {
    log('updates: nothing newer')
    if (asked) {
      say('StreamTorrent ' + app.getVersion() + ' is the newest version.')
      asked = false
    }
  })

  autoUpdater.on('update-downloaded', info => {
    log('updates: ' + info.version + ' is ready to install')
    waiting = info
    offerRestart()
  })

  autoUpdater.on('error', err => {
    log('updates: ' + (err && err.message ? err.message : String(err)))
    if (asked) {
      asked = false
      say('Could not check for updates.\n\n' +
        (err && err.message ? err.message : String(err)))
    }
  })

  return autoUpdater
}

/**
 * The installed app: a newer version is on disk and one restart away. Asked
 * only when nothing is playing - a box over a film is worse than a late
 * update.
 */
function offerRestart () {
  if (!waiting) return
  if (playing) {
    log('updates: ' + waiting.version + ' is ready, waiting for playback to end')
    return
  }

  const version = waiting.version
  const win = windows.main.win

  const options = {
    type: 'info',
    title: config.APP_NAME,
    message: 'Update ready: restart to install',
    detail: 'StreamTorrent ' + version + ' has been downloaded. ' +
      'Your torrents and settings are kept.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1
  }

  const handle = ({ response }) => {
    if (response !== 0) {
      // Left for later: it installs itself when the app is next quit
      log('updates: ' + version + ' will be installed on quit')
      waiting = null
      return
    }
    waiting = null
    app.isQuitting = true
    get().quitAndInstall()
  }

  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options).then(handle)
  else dialog.showMessageBox(options).then(handle)
}

/** The portable build: nothing to install, just point at the download. */
function offerDownload (version) {
  const win = windows.main.win

  const options = {
    type: 'info',
    title: config.APP_NAME,
    message: 'New version available',
    detail: 'StreamTorrent ' + version + ' is out. This is ' +
      app.getVersion() + '.\n\nThe portable build does not update itself - ' +
      'download the new one and unzip it over this folder. Your settings are ' +
      'in "Portable Settings" and are kept.',
    buttons: ['Open the releases page', 'Later'],
    defaultId: 0,
    cancelId: 1
  }

  const handle = ({ response }) => {
    if (response === 0) shell.openExternal(RELEASES_URL)
  }

  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options).then(handle)
  else dialog.showMessageBox(options).then(handle)
}

function say (message) {
  const win = windows.main.win
  const options = { type: 'info', title: config.APP_NAME, message }
  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options)
  else dialog.showMessageBox(options)
}
