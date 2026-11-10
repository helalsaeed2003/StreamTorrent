/**
 * The player's own bars: the header at the top and the controls at the bottom.
 *
 * They live in a window of their own, laid over the whole player, because mpv
 * paints the video into a native window that the page cannot draw on top of.
 * This way the picture fills the window and the bars float over it, fading in
 * and out, instead of the picture having to shrink to make room for them.
 *
 * The window lets the mouse through everywhere except over the bars
 * themselves, so clicking the picture still reaches the page underneath.
 */

const playerChrome = module.exports = {
  show,
  hide,
  setMouseOverBars,
  sync,
  isOpen,
  win: null
}

const path = require('path')

const { BrowserWindow } = require('electron')

const config = require('../../config')
const log = require('../log')

let open = false
let overBars = false

function isOpen () {
  return open
}

function create () {
  if (playerChrome.win && !playerChrome.win.isDestroyed()) return playerChrome.win

  const main = require('./main').win
  if (!main || main.isDestroyed()) return null

  const win = playerChrome.win = new BrowserWindow({
    parent: main,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    // Never take focus: the keyboard stays with the main window, so the app's
    // hotkeys keep working while a video plays
    focusable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  win.setMenuBarVisibility(false)
  win.loadURL('file://' + path.join(config.STATIC_PATH, 'player-chrome.html'))

  // Everywhere but the bars, the mouse goes through to the page underneath
  win.setIgnoreMouseEvents(true, { forward: true })

  watch(main)

  log('player chrome window created')
  return win
}

// Keep the bars glued to the main window
function watch (main) {
  const events = [
    'move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize',
    'enter-full-screen', 'leave-full-screen', 'restore', 'show'
  ]
  for (const event of events) main.on(event, sync)

  main.on('minimize', () => {
    if (playerChrome.win && !playerChrome.win.isDestroyed()) playerChrome.win.hide()
  })
  main.on('restore', () => {
    if (open && playerChrome.win && !playerChrome.win.isDestroyed()) {
      playerChrome.win.showInactive()
    }
  })
  main.on('hide', () => {
    if (playerChrome.win && !playerChrome.win.isDestroyed()) playerChrome.win.hide()
  })
}

function show (payload) {
  const win = create()
  if (!win) return

  open = true
  const send = () => win.webContents.send('player-chrome-data', payload)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()

  sync()
  if (!win.isVisible()) win.showInactive()
  win.moveTop()
}

function hide () {
  open = false
  overBars = false
  const win = playerChrome.win
  if (!win || win.isDestroyed()) return
  win.setIgnoreMouseEvents(true, { forward: true })
  if (win.isVisible()) win.hide()
}

/**
 * The page says whether the pointer is over one of the bars. While it is, the
 * window takes the mouse so the buttons can be used; the rest of the time it
 * lets every click through to the picture.
 */
function setMouseOverBars (value) {
  const win = playerChrome.win
  if (!win || win.isDestroyed()) return
  if (value === overBars) return

  overBars = value
  win.setIgnoreMouseEvents(!value, { forward: true })
}

function sync () {
  const win = playerChrome.win
  if (!win || win.isDestroyed() || !open) return

  const main = require('./main').win
  if (!main || main.isDestroyed()) return

  const area = main.getContentBounds()
  win.setBounds(area)
}
