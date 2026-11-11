module.exports = {
  handleEvent
}

const { app } = require('electron')

const path = require('path')
const spawn = require('child_process').spawn

const handlers = require('./handlers')

const EXE_NAME = path.basename(process.execPath)
const UPDATE_EXE = path.join(process.execPath, '..', '..', 'Update.exe')

const run = (args, done) => {
  spawn(UPDATE_EXE, args, { detached: true })
    .on('close', done)
}

function handleEvent (cmd) {
  if (cmd === '--squirrel-install' || cmd === '--squirrel-updated') {
    // No shortcuts are made here. Update.exe cannot name them, and it puts the
    // Start menu one inside a folder of its own; install-shortcuts writes them
    // instead, to what the user asked for, the first time the app runs.
    app.quit()
    return true
  }

  if (cmd === '--squirrel-uninstall') {
    // Uninstall .torrent file and magnet link handlers
    handlers.uninstall()

    // Our own shortcuts are named differently from Squirrel's, so Update.exe
    // would leave them behind
    try {
      require('./install-shortcuts').removeAll()
    } catch (err) {}

    run([`--removeShortcut=${EXE_NAME}`], app.quit)
    return true
  }

  if (cmd === '--squirrel-obsolete') {
    app.quit()
    return true
  }

  return false
}
