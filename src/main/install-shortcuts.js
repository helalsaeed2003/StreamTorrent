/**
 * The shortcuts the installer leaves behind.
 *
 * Squirrel makes a desktop shortcut and a Start menu one when the app is
 * installed, before anything can be asked. The first time the app is then run
 * by the installer it asks which of them to keep and takes the others away.
 */

module.exports = {
  askOnFirstRun,
  create,
  remove
}

const { app, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const config = require('../config')
const log = require('./log')

const EXE_NAME = path.basename(process.execPath)
const UPDATE_EXE = path.join(path.dirname(process.execPath), '..', 'Update.exe')

const BOTH = 'Desktop,StartMenu'

function available () {
  return process.platform === 'win32' && fs.existsSync(UPDATE_EXE)
}

function run (args) {
  try {
    spawn(UPDATE_EXE, args, { detached: true, windowsHide: true })
  } catch (err) {
    log('could not run Update.exe', err)
  }
}

function create (locations) {
  if (!available() || !locations) return
  run([`--createShortcut=${EXE_NAME}`, `--shortcut-locations=${locations}`])
}

function remove (locations) {
  if (!available() || !locations) return
  run([`--removeShortcut=${EXE_NAME}`, `--shortcut-locations=${locations}`])
}

/**
 * Asked once, right after installing: which shortcuts should stay. Both are
 * there already, so anything not chosen is taken away again.
 */
function askOnFirstRun (win) {
  if (!available()) return

  const options = {
    type: 'question',
    title: config.APP_NAME,
    message: 'Where would you like shortcuts to ' + config.APP_NAME + '?',
    detail: 'You can change this later by making or deleting the shortcuts yourself.',
    buttons: ['Desktop and Start menu', 'Start menu only', 'Desktop only', 'Neither'],
    defaultId: 0,
    cancelId: 0
  }

  const choose = ({ response }) => {
    if (response === 0) return create(BOTH)
    if (response === 1) {
      create('StartMenu')
      remove('Desktop')
      return
    }
    if (response === 2) {
      create('Desktop')
      remove('StartMenu')
      return
    }
    remove(BOTH)
  }

  const show = win && !win.isDestroyed()
    ? dialog.showMessageBox(win, options)
    : dialog.showMessageBox(options)

  show.then(choose).catch(err => log('could not ask about shortcuts', err))

  // Nothing else depends on the answer, so the app carries on meanwhile
  if (!app.isReady()) log('asked about shortcuts before the app was ready')
}
