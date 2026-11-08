module.exports = {
  setPaths,
  wipe
}

const config = require('../config')
const tempPath = require('../temp-path')
const rawLog = require('./log')

// This runs while the app is shutting down, when the windows the logger writes
// to may already be gone. Never let logging stop the cleanup.
function log (...args) {
  try {
    rawLog(...args)
  } catch (err) {}
  console.log(...args)
}

// The folder temporary files go in, plus any folders used before the setting
// was changed. The renderer tells us these once it has read the preferences;
// until then the default is the best guess.
let current = config.TEMP_PATH
let stale = []

function setPaths (dir, stalePaths) {
  if (dir) current = dir
  stale = Array.isArray(stalePaths) ? stalePaths.filter(p => p && p !== current) : []
  log('Temporary files go in ' + current)
}

/**
 * Deletes the temp folders holding the files played this session.
 *
 * Runs when the app starts and when it quits, so that a crash, a forced quit or
 * a Windows shutdown that cut the app off can never leave torrent data behind.
 * Only folders StreamTorrent created are touched - see src/temp-path.js.
 */
function wipe (saved) {
  // At startup the preferences are read before any window exists, so work the
  // folder out directly rather than waiting to be told
  if (saved) {
    current = tempPath.resolve(saved.prefs)
    stale = (saved.staleTempPaths || []).filter(p => p && p !== current)
  }

  let allGone = true
  for (const dir of [current, ...stale]) {
    const result = tempPath.wipe(dir, { log })
    if (!result.deleted && !result.skipped) allGone = false
  }

  return allGone
}
