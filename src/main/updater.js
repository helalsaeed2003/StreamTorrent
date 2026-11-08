module.exports = {
  init
}

const log = require('./log')

// Auto-update is deliberately disabled.
//
// StreamTorrent is a modified build of WebTorrent Desktop. If it updated itself
// from the upstream release feed it would replace itself with stock WebTorrent
// Desktop and every change in this build would be lost. There is no update
// check, no update feed and no download.
function init () {
  log('Auto-update is disabled in this build')
}
