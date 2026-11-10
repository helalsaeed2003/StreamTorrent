/**
 * The player's own bars: the header at the top and the controls at the bottom.
 *
 * They live in windows of their own, laid over the player, because mpv paints
 * the video into a native window that the page cannot draw on top of. This way
 * the picture fills the window and the bars sit over it, instead of the picture
 * having to shrink to make room for them.
 *
 * There is one window per bar, each only as tall as its bar, so the picture
 * between them is never covered and every click there reaches the page. They
 * are drawn solid and then made see-through with setOpacity: a window made
 * transparent in the usual way comes out grey on this machine, where the
 * interface is drawn without the graphics card.
 */

const playerChrome = module.exports = {
  show,
  hide,
  sync,
  raise,
  setHovering,
  isOpen,
  windows: {}
}

const path = require('path')

const { BrowserWindow } = require('electron')

const config = require('../../config')
const log = require('./../log')

// How see-through the bars are, and how tall the one at the bottom is: the
// controls themselves plus the seek bar along their top edge. Nothing more, so
// no dark strip is left standing over the picture, and the bar never changes
// size under the pointer.
const OPACITY = 0.88
const BOTTOM_HEIGHT = config.UI_PLAYER_CONTROLS_HEIGHT

// The time under the pointer floats in a small window of its own, which is
// see-through everywhere except the label itself
const PREVIEW_WIDTH = 96
const PREVIEW_HEIGHT = config.UI_PLAYER_PREVIEW_HEIGHT

let open = false

/**
 * The pointer is on the seek bar, or has left it. While it is there, the time
 * under it is shown just above the bar, in a window of its own: the bar itself
 * keeps its size, so nothing jumps and nothing else covers the picture.
 */
function setHovering (data) {
  const win = previewWindow()
  if (!win) return

  if (!open || !data || !data.on) {
    if (win.isVisible()) win.hide()
    return
  }

  const main = require('./main').win
  if (!main || main.isDestroyed()) return

  const area = main.getContentBounds()
  const wanted = Math.round(area.x + (data.x || 0) - PREVIEW_WIDTH / 2)
  const limit = area.x + area.width - PREVIEW_WIDTH - 4

  win.setBounds({
    x: Math.max(area.x + 4, Math.min(wanted, limit)),
    // Sitting on the bar, so its point touches the seek bar
    y: area.y + area.height - BOTTOM_HEIGHT - PREVIEW_HEIGHT + 2,
    width: PREVIEW_WIDTH,
    height: PREVIEW_HEIGHT
  })

  const send = () => win.webContents.send('player-chrome-preview', data.text || '')
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()

  if (!win.isVisible()) win.showInactive()
  win.moveTop()
}

function previewWindow () {
  const win = create('preview')
  return win && !win.isDestroyed() ? win : null
}

function isOpen () {
  return open
}

function create (part) {
  const existing = playerChrome.windows[part]
  if (existing && !existing.isDestroyed()) return existing

  const main = require('./main').win
  if (!main || main.isDestroyed()) return null

  // The time under the pointer is a label with a point at the bottom, so its
  // window has to be see-through around it rather than a dark rectangle
  const floating = part === 'preview'

  const win = new BrowserWindow({
    parent: main,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // Never take focus: the keyboard stays with the main window, so the app's
    // hotkeys keep working while a video plays
    focusable: false,
    transparent: floating,
    backgroundColor: floating ? '#00000000' : '#101010',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  playerChrome.windows[part] = win
  win.setMenuBarVisibility(false)
  if (floating) win.setIgnoreMouseEvents(true)
  else win.setOpacity(OPACITY)
  win.loadURL('file://' + path.join(config.STATIC_PATH, 'player-chrome.html') +
    '?part=' + part)

  if (Object.keys(playerChrome.windows).length === 1) watch(main)

  log('player ' + part + ' bar created')
  return win
}

// Keep the bars glued to the main window
function watch (main) {
  const events = [
    'move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize',
    'enter-full-screen', 'leave-full-screen', 'restore', 'show'
  ]
  for (const event of events) main.on(event, sync)

  main.on('minimize', hideWindows)
  main.on('hide', hideWindows)
  main.on('restore', () => { if (open) showWindows() })
}

function show (payload) {
  const parts = ['header', 'controls']
  open = true

  for (const part of parts) {
    const win = create(part)
    if (!win) continue

    const send = () => win.webContents.send('player-chrome-data', payload)
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
  }

  // The bars come and go with the pointer: when they are not wanted, the
  // windows are taken away altogether, so nothing covers the picture
  sync()
  if (payload && payload.visible) showWindows()
  else hideWindows()
}

function hide () {
  open = false
  hideWindows()
}

// The two bars. The time under the pointer comes and goes on its own.
function bars () {
  return ['header', 'controls']
    .map(part => playerChrome.windows[part])
    .filter(win => win && !win.isDestroyed())
}

function showWindows () {
  for (const win of bars()) {
    if (!win.isVisible()) win.showInactive()
    win.moveTop()
  }
}

function hideWindows () {
  for (const win of Object.values(playerChrome.windows)) {
    if (!win || win.isDestroyed()) continue
    if (win.isVisible()) win.hide()
  }
}

function sync () {
  if (!open) return

  const main = require('./main').win
  if (!main || main.isDestroyed()) return

  const area = main.getContentBounds()

  place('header', {
    x: area.x,
    y: area.y,
    width: area.width,
    height: config.UI_HEADER_HEIGHT
  })

  place('controls', {
    x: area.x,
    y: area.y + area.height - BOTTOM_HEIGHT,
    width: area.width,
    height: BOTTOM_HEIGHT
  })

  // Moving the main window, and showing the video window with it, puts the
  // bars underneath. Clicks would then land on the page behind the picture
  // instead of on the controls, so put them back on top every time.
  raise()
}

// Keep the bars above the video window, which is raised whenever the main
// window is shown or restored
function raise () {
  if (!open) return
  for (const win of bars()) {
    if (win.isVisible()) win.moveTop()
  }
}

function place (part, bounds) {
  const win = playerChrome.windows[part]
  if (!win || win.isDestroyed()) return
  win.setBounds(bounds)
}
