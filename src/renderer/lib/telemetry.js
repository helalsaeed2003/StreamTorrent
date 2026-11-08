// Telemetry is disabled in StreamTorrent.
//
// The upstream app collects anonymous usage statistics and uncaught errors and
// posts them to a server. This build never contacts any server and keeps no
// per-install identifier. The functions below keep the same shape as before so
// the rest of the app can call them, but they only write to the local console.
module.exports = {
  init,
  send,
  logUncaughtError,
  logPlayAttempt
}

function init (state) {
  // Drop any identifier an earlier build may have saved, so it is not carried
  // around in the config file
  if (state && state.saved && state.saved.telemetry) {
    delete state.saved.telemetry
  }
}

function send () {}

function logPlayAttempt (result) {
  console.log('play attempt: %s', result)
}

function logUncaughtError (procName, e) {
  const message = (e && (e.message || (e.error && e.error.message))) || String(e)
  const stack = (e && (e.stack || (e.error && e.error.stack))) || ''
  console.error('uncaught error in %s: %s\n%s', procName, message, stack)
}
