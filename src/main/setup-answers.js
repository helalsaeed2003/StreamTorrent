/**
 * What the installer was told to do, carried out the first time the app runs.
 *
 * The installer asks the usual Windows questions on its own page — desktop
 * shortcut, Start menu shortcut, open .torrent files, open magnet links — and
 * writes the answers to HKCU\Software\StreamTorrent\Setup. It cannot do the
 * work itself: the shortcuts have to be named and pointed the way the app
 * names and points them, and the file associations need a signed UserChoice
 * entry that only a program running as the user can write (see
 * user-choice.js). So the installer records, and this reads the answers once,
 * acts on them, and deletes them.
 *
 * With no answers waiting — every ordinary start, and the portable build,
 * which has no installer — the shortcuts already asked for are put back
 * instead, since Squirrel used to write its own over them after an update.
 */

const config = require('../config')
const log = require('./log')

// Where the installer leaves its answers. The same place the app keeps its
// other registry entries, so an uninstall takes it with everything else.
const KEY = '\\Software\\StreamTorrent\\Setup'

module.exports = {
  applyIfAny,
  KEY
}

const ANSWERS = [
  ['DesktopShortcut', 'desktop'],
  ['StartMenuShortcut', 'startMenu'],
  ['TorrentFiles', 'torrentFiles'],
  ['MagnetLinks', 'magnetLinks']
]

function isWindows () {
  return process.platform === 'win32'
}

// winreg hands back REG_DWORD as the string "0x1"
function asBool (value) {
  if (value == null) return false
  const n = Number(value)
  return Number.isNaN(n) ? false : n !== 0
}

function readAnswers () {
  return new Promise(resolve => {
    const Registry = require('winreg')
    const key = new Registry({ hive: Registry.HKCU, key: KEY })

    key.values((err, items) => {
      if (err || !items || items.length === 0) return resolve(null)

      const found = {}
      for (const item of items) found[item.name] = item.value

      // Written last by the installer, so a half-written key is ignored
      if (!asBool(found.Pending)) return resolve(null)

      const choice = {}
      for (const [name, as] of ANSWERS) choice[as] = asBool(found[name])
      resolve(choice)
    })
  })
}

function clearAnswers () {
  return new Promise(resolve => {
    const Registry = require('winreg')
    new Registry({ hive: Registry.HKCU, key: KEY }).destroy(() => resolve())
  })
}

/**
 * Carries out what the installer was asked for, or puts back the shortcuts
 * from last time when there is nothing new to do.
 */
async function applyIfAny (prefs, win) {
  if (!isWindows() || !config.IS_PRODUCTION || config.IS_PORTABLE) return

  const shortcuts = require('./install-shortcuts')

  let choice = null
  try {
    choice = await readAnswers()
  } catch (err) {
    log('could not read what the installer was told: ' + err.message)
  }

  if (!choice) {
    shortcuts.reconcile(prefs, win)
    return
  }

  log('installer asked for: ' +
    (Object.keys(choice).filter(k => choice[k]).join(', ') || 'nothing'))

  // The answers go first, so that a crash in what follows cannot leave the
  // app asking Windows the same questions on every start
  await clearAnswers()

  shortcuts.applyChoice(choice, win)
  await takeAssociations(choice, win)
}

async function takeAssociations (choice, win) {
  const want = {
    torrentFiles: !!choice.torrentFiles,
    magnetLinks: !!choice.magnetLinks
  }

  // Written down either way: a "no" here is an answer, not an absence, and
  // the Preferences page shows it as an unticked box
  remember({
    isTorrentHandler: want.torrentFiles,
    isMagnetHandler: want.magnetLinks
  }, win)

  const handlers = require('./handlers')

  // A box left unticked is an answer. An install over an older version starts
  // with a config that already says yes to both, and the page it just showed
  // may say otherwise, so what was turned down is given back rather than only
  // not asked for.
  const declined = {
    torrentFiles: !want.torrentFiles,
    magnetLinks: !want.magnetLinks
  }
  if (declined.torrentFiles || declined.magnetLinks) {
    try {
      await handlers.uninstall(declined)
      log('turned down: ' +
        Object.keys(declined).filter(k => declined[k]).join(', '))
    } catch (err) {
      log('could not give back what was turned down: ' + err.message)
    }
  }

  if (!want.torrentFiles && !want.magnetLinks) return

  try {
    handlers.install(want)
  } catch (err) {
    log('could not register the handlers: ' + err.message)
    return
  }

  // Registering is not enough: Windows keeps the choice the user last made
  // and that choice wins, so it has to be written too. Whatever cannot be
  // written is left to Windows' own screen rather than quietly doing nothing.
  try {
    const left = await handlers.takeAssociationsWin32(want)
    log('still chosen elsewhere: ' + (left.join(', ') || 'nothing'))
    if (left.length > 0) setTimeout(() => handlers.openDefaultAppsSettings(), 400)
  } catch (err) {
    log('could not take the associations: ' + err.message)
  }
}

// Tells the page what was settled here. These are written down rather than
// acted on again: the work has already been done.
function remember (changes, win) {
  if (!win || win.isDestroyed()) return
  win.webContents.send('dispatch', 'rememberPreferences', changes)
}
