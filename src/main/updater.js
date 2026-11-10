/**
 * Updating in place.
 *
 * The installed app sits next to Squirrel's Update.exe, which can fetch a
 * newer version from a folder holding the RELEASES file and the .nupkg that
 * bin/package.js writes, and swap it in without the installer being run and
 * without touching the torrent list, the shortcuts or the preferences.
 *
 * The folder to look in is a preference, so the build folder can move.
 */

module.exports = {
  init,
  checkForUpdates
}

// Nothing is fetched from the internet: there is no update feed, and this
// build must never replace itself with stock WebTorrent Desktop. Updating
// means picking up a build from a folder on this machine.
function init () {
  log('updates come from the folder set in Preferences, never from the internet')
}

const { app, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const config = require('../config')
const log = require('./log')
const windows = require('./windows')

const UPDATE_EXE = path.join(path.dirname(process.execPath), '..', 'Update.exe')

// How long to let Update.exe run before giving up, in milliseconds
const TIMEOUT = 5 * 60 * 1000

/**
 * Looks in the update folder for a newer build and puts it in place.
 *
 * `silent` is for the check that runs by itself at startup: it says nothing
 * unless there is something to report.
 */
function checkForUpdates (folder, { silent = false } = {}) {
  if (process.platform !== 'win32' || !config.IS_PRODUCTION) {
    if (!silent) say('Updating in place only works in the installed app on Windows.')
    return
  }

  if (!fs.existsSync(UPDATE_EXE)) {
    if (!silent) say('This copy was not installed by StreamTorrentSetup.exe, so it cannot update itself.')
    return
  }

  const feed = (folder || '').trim()
  if (!feed || !fs.existsSync(path.join(feed, 'RELEASES'))) {
    if (!silent) {
      say('No builds found in ' + (feed || 'the update folder') +
        '.\n\nSet the folder holding RELEASES and the .nupkg files in Preferences.')
    }
    return
  }

  log('looking for a new version in ' + feed)

  run(['--update', feed], (code, output) => {
    if (code !== 0) {
      log('update failed: ' + output)
      if (!silent) say('Could not update: ' + (output.trim() || 'Update.exe exited ' + code))
      return
    }

    const installed = newestVersion(feed)
    if (!installed || installed === app.getVersion()) {
      log('already on the newest version')
      if (!silent) say('StreamTorrent ' + app.getVersion() + ' is the newest build in that folder.')
      return
    }

    log('updated to ' + installed)
    offerRestart(installed)
  })
}

// Runs Update.exe and collects whatever it says
function run (args, done) {
  let output = ''
  let finished = false

  const finish = (code) => {
    if (finished) return
    finished = true
    done(code, output)
  }

  const child = spawn(UPDATE_EXE, args, { windowsHide: true })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  child.on('error', err => finish(-1, (output += err.message)))
  child.on('close', finish)

  setTimeout(() => finish(-1), TIMEOUT)
}

// The newest version sitting in the update folder, from the RELEASES file
function newestVersion (feed) {
  let releases
  try {
    releases = fs.readFileSync(path.join(feed, 'RELEASES'), 'utf8')
  } catch (err) {
    return null
  }

  const versions = releases
    .split(/\r?\n/)
    .map(line => (line.match(/-(\d+\.\d+\.\d+)-full\.nupkg/) || [])[1])
    .filter(Boolean)

  return versions.length > 0 ? versions[versions.length - 1] : null
}

function offerRestart (version) {
  const win = windows.main.win
  const options = {
    type: 'info',
    title: 'StreamTorrent',
    message: 'StreamTorrent ' + version + ' is ready.',
    detail: 'It will be used the next time the app starts.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1
  }

  const handle = ({ response }) => {
    if (response !== 0) return
    app.relaunch()
    app.quit()
  }

  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options).then(handle)
  else dialog.showMessageBox(options).then(handle)
}

function say (message) {
  const win = windows.main.win
  const options = { type: 'info', title: 'StreamTorrent', message }
  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options)
  else dialog.showMessageBox(options)
}
