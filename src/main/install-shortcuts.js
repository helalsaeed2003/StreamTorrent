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

const { BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')

const config = require('../config')
const log = require('./log')

const EXE_NAME = path.basename(process.execPath)
const UPDATE_EXE = path.join(path.dirname(process.execPath), '..', 'Update.exe')

function available () {
  return process.platform === 'win32' && fs.existsSync(UPDATE_EXE)
}

function run (args) {
  try {
    const child = spawn(UPDATE_EXE, args, { detached: true, windowsHide: true })
    child.on('exit', code => log('Update.exe ' + args.join(' ') + ' finished with ' + code))
    child.on('error', err => log('could not run Update.exe', err))
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
 * Asked once, right after installing: a window of tick boxes, the way an
 * ordinary Windows installer asks. Both shortcuts are there already, so
 * anything left unticked is taken away again.
 */
function askOnFirstRun (win) {
  if (!available()) return

  const parent = win && !win.isDestroyed() ? win : undefined

  const chooser = new BrowserWindow({
    parent,
    modal: !!parent,
    width: 540,
    height: 380,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: config.APP_NAME + ' Setup',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  chooser.setMenuBarVisibility(false)
  chooser.loadURL('file://' + path.join(config.STATIC_PATH, 'first-run.html'))
  chooser.once('ready-to-show', () => chooser.show())

  ipcMain.once('first-run-choice', (e, choice) => {
    apply(choice, win)
    if (!chooser.isDestroyed()) chooser.close()
  })

  // Closing the window without answering leaves everything as the installer
  // left it: both shortcuts, and no change to what opens torrent files
  chooser.on('closed', () => ipcMain.removeAllListeners('first-run-choice'))
}

function apply (choice, win) {
  const wanted = []
  const unwanted = []

  ;(choice.desktop ? wanted : unwanted).push('Desktop')
  ;(choice.startMenu ? wanted : unwanted).push('StartMenu')

  if (wanted.length) create(wanted.join(','))
  if (unwanted.length) remove(unwanted.join(','))

  log('shortcuts kept: ' + (wanted.join(',') || 'none'))

  // Registered here rather than left to the page: what was asked for happens
  // whether or not the page is listening by now
  const handlers = require('./handlers')
  try {
    if (choice.fileHandler) handlers.install()
    else handlers.uninstall()
    log('torrent files and magnet links: ' + (choice.fileHandler ? 'ours' : 'left alone'))
  } catch (err) {
    log('could not register the handlers', err)
  }

  // The page keeps the preference, so Preferences shows what was chosen
  if (win && !win.isDestroyed()) {
    win.webContents.send('dispatch', 'updatePreferences', 'isFileHandler',
      !!choice.fileHandler)
  }
}
