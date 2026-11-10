/**
 * Where StreamTorrent puts the files it is streaming, and the rules that keep
 * cleaning up safe.
 *
 * By default this is a "Temp" folder inside the program's own folder (or inside
 * "Portable Settings" for the portable build). It can be pointed somewhere else
 * from Preferences, in which case we always work inside a dedicated
 * "StreamTorrent Temp" subfolder of the chosen folder, never the folder itself.
 *
 * Every folder we create gets a marker file dropped in it. Nothing is ever
 * deleted unless that marker is there, so pointing the setting at, say, the
 * Downloads folder or the root of a drive cannot cost the user anything.
 */

const fs = require('fs')
const path = require('path')

const config = require('./config')

const DEDICATED_FOLDER_NAME = 'StreamTorrent Temp'
const MARKER_FILE = '.streamtorrent-temp'

// Each run of the app gets a folder of this name plus its process id, so two
// copies running at once never clear away each other's files
const SESSION_PREFIX = 'session-'

module.exports = {
  DEDICATED_FOLDER_NAME,
  MARKER_FILE,
  SESSION_PREFIX,
  resolve,
  wipeStaleSessions,
  prepare,
  ensure: create,
  isOurs,
  isInside,
  wipe,
  getSize
}

const MARKER_TEXT = [
  'This folder holds videos StreamTorrent is streaming right now.',
  'Everything in here is temporary and is deleted when StreamTorrent quits.',
  'StreamTorrent only ever deletes folders that contain this marker file.',
  ''
].join('\r\n')

/**
 * The folder we should be using, given the saved preferences.
 *
 * An empty or missing tempPath means "use the default". Inside it, each run of
 * the app gets a folder of its own, named after the process, so that several
 * copies of StreamTorrent can run at once without one clearing away what
 * another is still playing.
 */
function resolve (prefs) {
  return path.join(baseFolder(prefs), SESSION_PREFIX + mainProcessId())
}

// The folder the per-run folders live in
function baseFolder (prefs) {
  const chosen = prefs && typeof prefs.tempPath === 'string' ? prefs.tempPath.trim() : ''
  if (!chosen) return config.TEMP_PATH
  return path.join(chosen, DEDICATED_FOLDER_NAME)
}

// The main process decides the name, so every window of one run agrees on it
function mainProcessId () {
  if (process.type === 'renderer') {
    try {
      return require('@electron/remote').process.pid
    } catch (err) {
      return process.pid
    }
  }
  return process.pid
}

/**
 * Clears the folders left behind by runs that are over, leaving alone any that
 * belong to a copy of the app still going. Called at startup.
 */
function wipeStaleSessions (prefs, options = {}) {
  const base = baseFolder(prefs)
  const mine = SESSION_PREFIX + mainProcessId()
  const log = options.log || (() => {})

  let entries
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch (err) {
    return
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith(SESSION_PREFIX)) continue
    if (entry.name === mine) continue

    const pid = Number(entry.name.slice(SESSION_PREFIX.length))
    if (isRunning(pid)) {
      log('leaving ' + entry.name + ' alone: that copy is still running')
      continue
    }

    wipe(path.join(base, entry.name), options)
  }
}

// Is there still a process with this id?
function isRunning (pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Makes sure the folder exists, is writable, and is marked as ours.
// Falls back to the default location if the chosen one cannot be used, rather
// than failing silently.
// Returns { path, isDefault, usedFallback, wanted, error }
function prepare (prefs) {
  const wanted = resolve(prefs)
  const fallback = config.TEMP_PATH

  try {
    create(wanted)
    return { path: wanted, isDefault: wanted === fallback, usedFallback: false }
  } catch (err) {
    let fallbackError = null
    try {
      create(fallback)
    } catch (err2) {
      fallbackError = err2.message
    }
    return {
      path: fallback,
      isDefault: true,
      usedFallback: true,
      wanted,
      error: err.message,
      fallbackError
    }
  }
}

function create (dir) {
  fs.mkdirSync(dir, { recursive: true })
  // Writing the marker doubles as the writability check
  fs.writeFileSync(path.join(dir, MARKER_FILE), MARKER_TEXT)
}

// Did we create this folder? Only folders we made are ever deleted.
function isOurs (dir) {
  if (!dir) return false
  try {
    return fs.statSync(path.join(dir, MARKER_FILE)).isFile()
  } catch (err) {
    return false
  }
}

// Is `target` the temp folder itself, or something inside it?
function isInside (target, tempRoot) {
  if (!target || !tempRoot) return false
  const resolved = path.resolve(target)
  const root = path.resolve(tempRoot)
  return resolved === root || resolved.startsWith(root + path.sep)
}

/**
 * Deletes everything inside a temp folder, and the folder itself.
 *
 * Refuses unless the folder carries our marker, so a folder the user picked
 * that we did not create is left completely alone. Windows holds on to files
 * until the last handle is closed, so keep trying for a few seconds.
 *
 * Returns { deleted, skipped, error }
 */
function wipe (dir, { attempts = 20, delayMs = 150, log = () => {} } = {}) {
  if (!dir) return { deleted: false, skipped: 'no folder given' }

  const target = path.resolve(dir)

  if (!fs.existsSync(target)) return { deleted: true }

  if (!isOurs(target)) {
    log('refusing to delete ' + target + ': not a folder StreamTorrent created')
    return { deleted: false, skipped: 'not ours' }
  }

  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (!fs.existsSync(target)) {
        log('deleted ' + target)
        return { deleted: true }
      }
    } catch (err) {
      lastError = err
    }
    sleepSync(delayMs)
  }

  log('could not delete ' + target + (lastError ? ': ' + lastError.message : ': still in use'))
  return { deleted: false, error: lastError ? lastError.message : 'still in use' }
}

// Total size of a folder, in bytes. Used by the Preferences screen.
function getSize (dir) {
  if (!dir || !fs.existsSync(dir)) return 0

  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else {
        try {
          total += fs.statSync(full).size
        } catch (err) {}
      }
    }
  }
  walk(dir)

  return total
}

// Blocks briefly. Only used while starting up or shutting down.
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
