console.time('init')

require('@electron/remote/main').initialize()
const { app, ipcMain } = require('electron')

// Start crash reporter early, so it takes effect for child processes
const crashReporter = require('../crash-reporter')
crashReporter.init()

const parallel = require('run-parallel')

const config = require('../config')
const ipc = require('./ipc')
const log = require('./log')
const menu = require('./menu')
const State = require('../renderer/lib/state')
const streams = require('./streams')
const windows = require('./windows')

const WEBTORRENT_VERSION = require('webtorrent/package.json').version

let shouldQuit = false
let argv = sliceArgv(process.argv)

// allow electron/chromium to play startup sounds (without user interaction)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/**
 * Draw the interface without the graphics card.
 *
 * Chromium's GPU process crashes here with STATUS_STACK_BUFFER_OVERRUN
 * (exit code -1073740791), several times over, the first time anything heavy
 * is drawn: opening Preferences or the remove-torrent question would flash the
 * window black until Chromium gave up and fell back to software drawing on its
 * own. Starting that way costs nothing, since the interface is a few pages of
 * HTML and the video is drawn by mpv in a window of its own.
 */
app.disableHardwareAcceleration()

// Start the app without showing the main window when auto launching on login
// (On Windows and Linux, we get a flag. On MacOS, we get special API.)
const hidden = argv.includes('--hidden') ||
  (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden)

if (config.IS_PRODUCTION) {
  // When Electron is running in production mode (packaged app), then run React
  // in production mode too.
  process.env.NODE_ENV = 'production'
}

if (process.platform === 'win32') {
  const squirrelWin32 = require('./squirrel-win32')
  shouldQuit = squirrelWin32.handleEvent(argv[0])
  argv = argv.filter((arg) => !arg.includes('--squirrel'))
}

if (!shouldQuit && !config.IS_PORTABLE) {
  // Prevent multiple instances of app from running at same time. New instances
  // signal this instance and quit. Note: This feature creates a lock file in
  // %APPDATA%\Roaming\WebTorrent so we do not do it for the Portable App since
  // we want to be "silent" as well as "portable".
  if (!app.requestSingleInstanceLock()) {
    shouldQuit = true
  }
}

if (shouldQuit) {
  app.quit()
} else {
  init()
}

function init () {
  app.on('second-instance', (event, commandLine, workingDirectory) => onAppOpen(commandLine))
  if (config.IS_PORTABLE) {
    const path = require('path')
    // Put all user data into the "Portable Settings" folder
    app.setPath('userData', config.CONFIG_PATH)
    // Put Electron crash files, etc. into the "Portable Settings\Temp" folder
    app.setPath('temp', path.join(config.CONFIG_PATH, 'Temp'))
  }

  let isReady = false // app ready, windows can be created
  app.ipcReady = false // main window has finished loading and IPC is ready
  app.isQuitting = false

  parallel({
    appReady: (cb) => app.on('ready', () => cb(null)),
    state: (cb) => State.load(cb)
  }, onReady)

  function onReady (err, results) {
    if (err) throw err

    isReady = true
    const state = results.state

    // Nothing played in a previous run should still be on disk. Clear the temp
    // folder before any window opens, in case the last run crashed or Windows
    // shut down before the cleanup could happen.
    streams.wipe(state.saved)

    menu.init()
    windows.main.init(state, { hidden })
    windows.webtorrent.init()

    // To keep app startup fast, some code is delayed.
    setTimeout(() => {
      delayedInit(state)
    }, config.DELAYED_INIT)

    // Report uncaught exceptions
    process.on('uncaughtException', (err) => {
      console.error(err)
      const error = { message: err.message, stack: err.stack }
      windows.main.dispatch('uncaughtError', 'main', error)
    })
  }

  // Enable app logging into default directory, i.e. /Library/Logs/WebTorrent
  // on Mac, %APPDATA% on Windows, $XDG_CONFIG_HOME or ~/.config on Linux.
  app.setAppLogsPath()

  // Identify as StreamTorrent to web servers and web seeds, with no link out
  app.userAgentFallback = `${config.APP_NAME}/${config.APP_VERSION} (WebTorrent/${WEBTORRENT_VERSION})`

  app.on('open-file', onOpen)
  app.on('open-url', onOpen)

  ipc.init()

  app.once('ipcReady', () => {
    log('Command line args:', argv)
    processArgv(argv)
    console.timeEnd('init')
  })

  app.on('before-quit', e => {
    if (app.isQuitting) return

    app.isQuitting = true
    e.preventDefault()

    let finished = false
    function finish () {
      if (finished) return
      finished = true
      // Last word on the temp folder, in case a handle was still open when the
      // WebTorrent process cleared it
      streams.wipe()
      app.quit()
    }

    // 1. Save the torrent list, settings and open folders
    windows.main.dispatch('stateSaveImmediate')

    ipcMain.once('stateSaved', async () => {
      // 2. Stop the video engine. It has the file being watched open, and
      //    Windows will not delete a file while a handle on it is alive.
      try {
        await require('./mpv').stop()
        windows.video.destroy()
      } catch (err) {
        log('Could not stop the video engine', err)
      }

      // 3. Have the WebTorrent process close every file it has open and clear
      //    the temp folder, then finish quitting
      ipcMain.once('wt-destroyed-all', finish)
      try {
        windows.webtorrent.send('wt-destroy-all')
      } catch (err) {
        log('Could not ask the WebTorrent process to clean up', err)
        return finish()
      }
      setTimeout(finish, 6000)
    })

    setTimeout(() => {
      console.error('Shutting down took too long. Quitting.')
      finish()
    }, 10000)
  })

  app.on('activate', () => {
    if (isReady) windows.main.show()
  })
}

function delayedInit (state) {
  if (app.isQuitting) return

  const dock = require('./dock')
  const FolderWatcher = require('./folder-watcher')
  const folderWatcher = new FolderWatcher({ window: windows.main, state })

  dock.init()

  // No auto-updater, and no announcement check: StreamTorrent never phones
  // home, and must never replace itself with a different build.

  ipc.setModule('folderWatcher', folderWatcher)
  if (folderWatcher.isEnabled()) {
    folderWatcher.start()
  }

  if (process.platform === 'win32') {
    const userTasks = require('./user-tasks')
    userTasks.init()
  }

  // No tray icon: closing the window quits the app and clears the temp folder,
  // rather than leaving it running out of sight holding on to the files
}

function onOpen (e, torrentId) {
  e.preventDefault()

  if (app.ipcReady) {
    // Magnet links opened from Chrome won't focus the app without a setTimeout.
    // The confirmation dialog Chrome shows causes Chrome to steal back the focus.
    // Electron issue: https://github.com/atom/electron/issues/4338
    setTimeout(() => windows.main.show(), 100)

    processArgv([torrentId])
  } else {
    argv.push(torrentId)
  }
}

function onAppOpen (newArgv) {
  newArgv = sliceArgv(newArgv)

  if (app.ipcReady) {
    log('Second app instance opened, but was prevented:', newArgv)
    windows.main.show()

    processArgv(newArgv)
  } else {
    argv.push(...newArgv)
  }
}

// Remove leading args.
// Production: 1 arg, eg: /Applications/WebTorrent.app/Contents/MacOS/WebTorrent
// Development: 2 args, eg: electron .
// Test: 4 args, eg: electron -r .../mocks.js .
function sliceArgv (argv) {
  return argv.slice(
    config.IS_PRODUCTION
      ? 1
      : config.IS_TEST
        ? 4
        : 2
  )
}

function processArgv (argv) {
  const torrentIds = []
  argv.forEach(arg => {
    if (arg === '-n' || arg === '-o' || arg === '-u') {
      // Critical path: Only load the 'dialog' package if it is needed
      const dialog = require('./dialog')
      if (arg === '-n') {
        dialog.openSeedDirectory()
      } else if (arg === '-o') {
        dialog.openTorrentFile()
      } else if (arg === '-u') {
        dialog.openTorrentAddress()
      }
    } else if (arg === '--hidden') {
      // Ignore hidden argument, already being handled
    } else if (arg.startsWith('-psn')) {
      // Ignore Mac launchd "process serial number" argument
      // Issue: https://github.com/webtorrent/webtorrent-desktop/issues/214
    } else if (arg.startsWith('--')) {
      // Ignore Spectron flags
    } else if (arg === 'data:,') {
      // Ignore weird Spectron argument
    } else if (arg !== '.') {
      // Ignore '.' argument, which gets misinterpreted as a torrent id, when a
      // development copy of WebTorrent is started while a production version is
      // running.
      torrentIds.push(arg)
    }
  })
  if (torrentIds.length > 0) {
    windows.main.dispatch('onOpen', torrentIds)
  }
}
