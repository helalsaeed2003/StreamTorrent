module.exports = {
  init
}

const log = require('./log')

// The upstream app checks a remote endpoint on startup for messages to show the
// user. StreamTorrent does not contact any server, so this does nothing.
function init () {
  log('Announcement checks are disabled in this build')
}
