/**
 * The window mpv draws into.
 *
 * A native video surface always sits on top of the page, so instead of letting
 * it cover the whole window we give it exactly the strip between the header and
 * the player controls. The app's own controls stay visible and clickable, and
 * when they hide themselves the video grows to fill the window.
 *
 * It is a borderless child of the main window that we keep glued to it, so it
 * follows every move, resize, maximise and full-screen.
 */

const video = module.exports = {
  create,
  destroy,
  getHandle,
  setInsets,
  sync,
  win: null
}

const { BrowserWindow } = require('electron')

const log = require('../log')

// How much of the window the video should leave alone, in pixels: the header at
// the top and the controls at the bottom. The renderer updates these as the
// controls show and hide.
let insets = { top: 0, bottom: 0 }

function create () {
  if (video.win && !video.win.isDestroyed()) return video.win

  const main = require('./main').win
  if (!main || main.isDestroyed()) return null

  const win = video.win = new BrowserWindow({
    parent: main,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never take focus: the keyboard stays with the main window so the app's
    // hotkeys keep working while a video plays
    focusable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })

  // Nothing is ever loaded into it; mpv paints over the whole thing
  win.setMenuBarVisibility(false)

  /**
   * The window shows the video but takes no mouse input: every click, move
   * and scroll goes straight through to the page underneath, as if the video
   * were part of it.
   *
   * This matters because mpv, when it is drawing into a window we gave it,
   * does not handle mouse input at all. Without this the picture would be a
   * dead area: the controls could never be brought back once they hid
   * themselves, clicking would not bring the app forward, and clicking the
   * picture would not pause.
   */
  win.setIgnoreMouseEvents(true)

  watch(main)
  sync()
  win.showInactive()

  log('video window created')
  return win
}

// Keep the video glued to the main window
function watch (main) {
  const events = [
    'move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize',
    'enter-full-screen', 'leave-full-screen', 'restore', 'show'
  ]
  for (const event of events) main.on(event, sync)

  main.on('minimize', () => {
    if (video.win && !video.win.isDestroyed()) video.win.hide()
  })
  main.on('restore', () => {
    if (video.win && !video.win.isDestroyed()) video.win.showInactive()
  })
  main.on('hide', () => {
    if (video.win && !video.win.isDestroyed()) video.win.hide()
  })
  main.on('show', () => {
    if (video.win && !video.win.isDestroyed()) video.win.showInactive()
  })
}

function setInsets (top, bottom) {
  insets = {
    top: Math.max(0, Math.round(top || 0)),
    bottom: Math.max(0, Math.round(bottom || 0))
  }
  sync()
}

function sync () {
  const win = video.win
  if (!win || win.isDestroyed()) return

  const main = require('./main').win
  if (!main || main.isDestroyed()) return

  const bounds = main.getContentBounds()
  const height = bounds.height - insets.top - insets.bottom

  // A window of zero height upsets mpv, so keep at least a sliver
  win.setBounds({
    x: bounds.x,
    y: bounds.y + insets.top,
    width: Math.max(1, bounds.width),
    height: Math.max(1, height)
  })
}

// The native handle mpv needs for --wid
function getHandle () {
  const win = video.win
  if (!win || win.isDestroyed()) return null

  const buf = win.getNativeWindowHandle()
  return buf.length === 8
    ? buf.readBigUInt64LE().toString()
    : String(buf.readUInt32LE())
}

function destroy () {
  const win = video.win
  video.win = null
  if (!win || win.isDestroyed()) return
  try {
    win.destroy()
  } catch (err) {
    log('could not close the video window', err.message)
  }
}
