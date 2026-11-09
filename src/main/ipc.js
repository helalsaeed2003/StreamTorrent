module.exports = {
  init,
  setModule
}

const { app, ipcMain } = require('electron')

const log = require('./log')
const menu = require('./menu')
const windows = require('./windows')

// Messages from the main process, to be sent once the WebTorrent process starts
const messageQueueMainToWebTorrent = []

// Will hold modules injected from the app that will be used on fired
// IPC events.
const modules = {}

function setModule (name, module) {
  modules[name] = module
}

function init () {
  ipcMain.once('ipcReady', e => {
    app.ipcReady = true
    app.emit('ipcReady')
  })

  ipcMain.once('ipcReadyWebTorrent', e => {
    app.ipcReadyWebTorrent = true
    log('sending %d queued messages from the main win to the webtorrent window',
      messageQueueMainToWebTorrent.length)
    messageQueueMainToWebTorrent.forEach(message => {
      windows.webtorrent.send(message.name, ...message.args)
      log('webtorrent: sent queued %s', message.name)
    })
  })

  /**
   * Dialog
   */

  ipcMain.on('openTorrentFile', () => {
    const dialog = require('./dialog')
    dialog.openTorrentFile()
  })
  ipcMain.on('openFiles', () => {
    const dialog = require('./dialog')
    dialog.openFiles()
  })

  /**
   * Dock
   */

  ipcMain.on('setBadge', (e, ...args) => {
    const dock = require('./dock')
    dock.setBadge(...args)
  })
  ipcMain.on('downloadFinished', (e, ...args) => {
    const dock = require('./dock')
    dock.downloadFinished(...args)
  })

  /**
   * Player Events
   */

  ipcMain.on('onPlayerOpen', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const shortcuts = require('./shortcuts')
    const thumbar = require('./thumbar')

    menu.togglePlaybackControls(true)
    powerSaveBlocker.enable()
    shortcuts.enable()
    thumbar.enable()
  })

  ipcMain.on('onPlayerUpdate', (e, ...args) => {
    const thumbar = require('./thumbar')

    menu.onPlayerUpdate(...args)
    thumbar.onPlayerUpdate(...args)
  })

  ipcMain.on('onPlayerClose', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const shortcuts = require('./shortcuts')
    const thumbar = require('./thumbar')

    menu.togglePlaybackControls(false)
    powerSaveBlocker.disable()
    shortcuts.disable()
    thumbar.disable()
  })

  ipcMain.on('onPlayerPlay', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const thumbar = require('./thumbar')

    powerSaveBlocker.enable()
    thumbar.onPlayerPlay()
  })

  ipcMain.on('onPlayerPause', () => {
    const powerSaveBlocker = require('./power-save-blocker')
    const thumbar = require('./thumbar')

    powerSaveBlocker.disable()
    thumbar.onPlayerPause()
  })

  /**
   * Folder Watcher Events
   */

  ipcMain.on('startFolderWatcher', () => {
    if (!modules.folderWatcher) {
      log('IPC ERR: folderWatcher module is not defined.')
      return
    }

    modules.folderWatcher.start()
  })

  ipcMain.on('stopFolderWatcher', () => {
    if (!modules.folderWatcher) {
      log('IPC ERR: folderWatcher module is not defined.')
      return
    }

    modules.folderWatcher.stop()
  })

  /**
   * Shell
   */

  ipcMain.on('openPath', (e, ...args) => {
    const shell = require('./shell')
    shell.openPath(...args)
  })
  ipcMain.on('showItemInFolder', (e, ...args) => {
    const shell = require('./shell')
    shell.showItemInFolder(...args)
  })
  ipcMain.on('moveItemToTrash', (e, ...args) => {
    const shell = require('./shell')
    shell.moveItemToTrash(...args)
  })

  /**
   * File handlers
   */

  ipcMain.on('setDefaultFileHandler', (e, flag) => {
    const handlers = require('./handlers')

    if (flag) handlers.install()
    else handlers.uninstall()
  })

  /**
   * Auto start on login
   */

  ipcMain.on('setStartup', (e, flag) => {
    const startup = require('./startup')

    if (flag) startup.install()
    else startup.uninstall()
  })

  /**
   * Windows: Main
   */

  const main = windows.main

  ipcMain.on('setAspectRatio', (e, ...args) => main.setAspectRatio(...args))
  ipcMain.on('setBounds', (e, ...args) => main.setBounds(...args))
  ipcMain.on('setProgress', (e, ...args) => main.setProgress(...args))
  ipcMain.on('setTitle', (e, ...args) => main.setTitle(...args))
  ipcMain.on('show', () => main.show())
  ipcMain.on('toggleFullScreen', (e, ...args) => main.toggleFullScreen(...args))
  ipcMain.on('setAllowNav', (e, ...args) => menu.setAllowNav(...args))

  // The renderer works the temp folder out from the saved preferences and
  // tells us, so the cleanup at quit clears the right place
  ipcMain.on('setTempPath', (e, dir, stale) => {
    const streams = require('./streams')
    streams.setPaths(dir, stale)
  })

  /**
   * Video engine (mpv), drawing inside the main window
   */

  // Opening and closing the video engine are queued one after another. Closing
  // it takes a moment (mpv has to let go of the file), and playing another
  // video right away must not start a second mpv on top of the one still
  // shutting down.
  let videoQueue = Promise.resolve()
  const queueVideo = work => {
    videoQueue = videoQueue.then(work, work)
    return videoQueue
  }

  // Open the video surface and start mpv attached to it
  ipcMain.on('mpv-open', (e, insets, session) => queueVideo(async () => {
    const mpv = require('./mpv')
    const video = windows.video

    video.setInsets(insets && insets.top, insets && insets.bottom)
    const win = video.create()
    if (!win) return windows.main.send('mpv-error', 'Could not open the video area')

    const wid = video.getHandle()
    if (!wid) return windows.main.send('mpv-error', 'Could not get a window for the video')

    try {
      await mpv.start({ wid })
      windows.main.send('mpv-ready', session)
    } catch (err) {
      windows.main.send('mpv-error', err.message)
    }
  }))

  // The controls showed or hid, so the video area changed shape
  ipcMain.on('mpv-set-insets', (e, insets) => {
    windows.video.setInsets(insets && insets.top, insets && insets.bottom)
  })

  ipcMain.on('mpv-load', (e, url, options) => {
    require('./mpv').load(url, options)
  })

  ipcMain.on('mpv-command', (e, args) => {
    require('./mpv').command(args)
  })

  ipcMain.on('mpv-set-property', (e, name, value) => {
    require('./mpv').setProperty(name, value)
  })

  // Asks mpv for something and sends the answer back under a reply id
  ipcMain.on('mpv-get-property', async (e, replyId, name) => {
    const value = await require('./mpv').command(['get_property', name])
    windows.main.send('mpv-property-reply', replyId, value)
  })

  // Close the player: stop mpv and take the video surface away. The session
  // number goes back with the reply, so a player that has already been opened
  // again ignores the news that the previous one finished closing.
  ipcMain.on('mpv-close', (e, session) => queueVideo(async () => {
    await require('./mpv').stop()
    windows.video.destroy()
    windows.main.send('mpv-closed', session)
  }))

  /**
   * External Media Player
   */

  /**
   * Message passing
   */

  const oldEmit = ipcMain.emit
  ipcMain.emit = (name, e, ...args) => {
    // Relay messages between the main window and the WebTorrent hidden window
    if (name.startsWith('wt-') && !app.isQuitting) {
      // Work out where the message came from by comparing the sender itself,
      // rather than matching on a window title that a rename could break
      const hiddenWin = windows.webtorrent.win
      const isFromHiddenWindow = !!hiddenWin && !hiddenWin.isDestroyed() &&
        e.sender === hiddenWin.webContents

      if (isFromHiddenWindow) {
        // Send message to main window
        windows.main.send(name, ...args)
        log('webtorrent: got %s', name)
      } else if (app.ipcReadyWebTorrent) {
        // Send message to webtorrent window
        windows.webtorrent.send(name, ...args)
        log('webtorrent: sent %s', name)
      } else {
        // Queue message for webtorrent window, it hasn't finished loading yet
        messageQueueMainToWebTorrent.push({
          name,
          args
        })
        log('webtorrent: queueing %s', name)
      }
      return
    }

    // Emit all other events normally
    oldEmit.call(ipcMain, name, e, ...args)
  }
}
