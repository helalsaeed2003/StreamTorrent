/**
 * The shortcuts the installer leaves behind.
 *
 * Squirrel makes its own pair when the app is installed, named after the
 * executable and with the Start menu one buried in a folder of its own. Those
 * are taken away and replaced with a single shortcut of our own, named the way
 * the app is written on screen, in the places the user asked for.
 *
 * The shortcuts are written here rather than by Update.exe, which cannot name
 * them and which cannot be asked to add one and remove another at the same
 * time without the two runs fighting over Squirrel's lock.
 */

const { app, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const config = require('../config')
const log = require('./log')

// What the shortcut is called. The executable cannot carry a space, so the
// shortcut is named separately from it.
const SHORTCUT_NAME = 'Stream Torrent'

module.exports = {
  applyChoice,
  reconcile,
  removeAll,
  SHORTCUT_NAME
}

// Squirrel's own naming, which is what has to be cleared away
const EXE_NAME = path.basename(process.execPath, '.exe')

// Shortcuts point at the stub one level above the versioned folder, so they
// keep working when the app updates itself into a new folder
const STUB_EXE = path.join(path.dirname(process.execPath), '..', EXE_NAME + '.exe')

function isWindows () {
  return process.platform === 'win32'
}

function programsDir () {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows',
    'Start Menu', 'Programs')
}

function linkPath (where) {
  const dir = where === 'desktop' ? app.getPath('desktop') : programsDir()
  return path.join(dir, SHORTCUT_NAME + '.lnk')
}

function exists (file) {
  try {
    return fs.existsSync(file)
  } catch (err) {
    return false
  }
}

/**
 * Writes one shortcut, or takes it away. The target is the stub executable, so
 * an update does not leave the shortcut pointing at a folder that is gone.
 */
function set (where, wanted) {
  const file = linkPath(where)

  if (!wanted) {
    try {
      fs.rmSync(file, { force: true })
    } catch (err) {
      log('could not remove ' + file + ': ' + err.message)
    }
    return
  }

  const target = exists(STUB_EXE) ? STUB_EXE : process.execPath

  try {
    const ok = shell.writeShortcutLink(file, 'create', {
      target,
      cwd: path.dirname(process.execPath),
      icon: target,
      iconIndex: 0,
      description: config.APP_NAME,
      appUserModelId: 'com.squirrel.' + EXE_NAME + '.' + EXE_NAME
    })
    if (!ok) log('could not write ' + file)
  } catch (err) {
    log('could not write ' + file + ': ' + err.message)
  }
}

/**
 * Takes away the shortcuts Squirrel made for itself, including the Start menu
 * folder it puts its own inside. Says which of them were there, so that an
 * upgrade can keep whatever the user already had.
 */
function clearSquirrelShortcuts () {
  const found = { desktop: false, startMenu: false }
  if (!isWindows()) return found

  const desktop = path.join(app.getPath('desktop'), EXE_NAME + '.lnk')
  if (exists(desktop)) {
    found.desktop = true
    try {
      fs.rmSync(desktop, { force: true })
    } catch (err) {
      log('could not remove ' + desktop + ': ' + err.message)
    }
  }

  // Squirrel puts its Start menu shortcut inside a folder named after the app,
  // where the Start menu shows it only once that folder is opened
  const folder = path.join(programsDir(), EXE_NAME)
  if (exists(path.join(folder, EXE_NAME + '.lnk'))) found.startMenu = true
  if (exists(folder)) {
    try {
      fs.rmSync(folder, { recursive: true, force: true })
    } catch (err) {
      log('could not remove ' + folder + ': ' + err.message)
    }
  }

  return found
}

/**
 * Makes what is on disk match what the user asked for, every time the app
 * starts. Squirrel writes its own shortcuts again after every update, so they
 * are cleared each time rather than only once.
 *
 * A config written before this setting existed has no answer in it. Rather
 * than guess, whatever shortcuts are already there are taken as the answer and
 * written down, so an upgrade never silently removes one.
 */
function reconcile (prefs, win) {
  if (!isWindows() || !prefs) return

  const squirrel = clearSquirrelShortcuts()

  const decide = (saved, where) => {
    if (saved != null) return !!saved
    return squirrel[where] || exists(linkPath(where))
  }

  const want = {
    desktop: decide(prefs.shortcutDesktop, 'desktop'),
    startMenu: decide(prefs.shortcutStartMenu, 'startMenu')
  }

  set('desktop', want.desktop)
  set('startMenu', want.startMenu)

  if (prefs.shortcutDesktop == null || prefs.shortcutStartMenu == null) {
    remember(
      { shortcutDesktop: want.desktop, shortcutStartMenu: want.startMenu },
      win
    )
  }
}

// Takes both shortcuts away, for when the app is being uninstalled
function removeAll () {
  if (!isWindows()) return
  clearSquirrelShortcuts()
  set('desktop', false)
  set('startMenu', false)
}

// Tells the page what was settled here, in one go. These are written down
// rather than acted on again: the work has already been done.
function remember (changes, win) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('dispatch', 'rememberPreferences', changes)
}

/**
 * Puts the shortcuts the installer was asked for in place. The installer
 * records the answers and the app writes the shortcuts, because the name on
 * them and where they go are the app's business, and because an update has
 * to be able to put back whatever was asked for the first time.
 */
function applyChoice (choice, win) {
  if (!isWindows()) return

  clearSquirrelShortcuts()

  const want = { desktop: !!choice.desktop, startMenu: !!choice.startMenu }
  set('desktop', want.desktop)
  set('startMenu', want.startMenu)

  log('shortcuts kept: ' +
    (Object.keys(want).filter(k => want[k]).join(',') || 'none'))

  remember({
    shortcutDesktop: want.desktop,
    shortcutStartMenu: want.startMenu
  }, win)
}
