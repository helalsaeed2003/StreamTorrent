/**
 * The player's menus: speed, subtitles and audio tracks.
 *
 * They live in a small window of their own, a borderless child of the main
 * window, because the video is drawn by mpv into a native window that the page
 * cannot draw on top of. A window can, so the menu appears over the picture
 * without the picture having to move or shrink to make room.
 *
 * It is anchored to the bottom right of the main window's content area, just
 * above the player controls, so it always opens in the same place and never
 * leaves the player.
 */

const playerMenu = module.exports = {
  show,
  hide,
  setHeight,
  isOpen,
  sync,
  win: null
}

const path = require('path')

const { BrowserWindow } = require('electron')

const config = require('../../config')
const log = require('../log')

// How wide the panel is, and how far it sits from the edges of the player
const WIDTH = 300
const MARGIN = 8

// What the menu is showing right now, and how tall the page says it is
let height = 200
let open = false

// When the menu last opened, and how long after that a lost focus is ignored
let openedAt = 0
const SETTLE_MS = 400

function isOpen () {
  return open
}

function create () {
  if (playerMenu.win && !playerMenu.win.isDestroyed()) return playerMenu.win

  const main = require('./main').win
  if (!main || main.isDestroyed()) return null

  const win = playerMenu.win = new BrowserWindow({
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
    backgroundColor: '#202020',
    // The menu can be given focus, so that its sliders can be dragged and its
    // buttons pressed while the app is in the background. A window that cannot
    // be given focus is never activated by a click, and on Windows the press
    // is swallowed. The focus goes back to the player when the menu closes.
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  })

  win.setMenuBarVisibility(false)
  win.loadURL('file://' + path.join(config.STATIC_PATH, 'player-menu.html'))

  watch(main)

  log('player menu window created')
  return win
}

// Keep the menu glued to the main window
function watch (main) {
  const events = [
    'move', 'moved', 'resize', 'resized', 'maximize', 'unmaximize',
    'enter-full-screen', 'leave-full-screen', 'restore', 'show'
  ]
  for (const event of events) main.on(event, sync)

  main.on('minimize', hide)
  main.on('hide', hide)

  // Looking at something else puts the menu away, as a menu should. Opening it
  // can itself shuffle the focus about for a moment, though, and a menu that
  // shuts the instant it opens looks like a button that does not work, so a
  // blur right after opening is ignored.
  main.on('blur', () => {
    if (!open) return
    if (Date.now() - openedAt < SETTLE_MS) return

    // Using the menu itself takes the focus off the player: that is not
    // looking at something else
    const focused = BrowserWindow.getFocusedWindow()
    if (focused && (focused === playerMenu.win || main.getChildWindows().includes(focused))) return

    hide()
    main.webContents.send('player-menu-closed')
  })
}

function show (payload) {
  const win = create()
  if (!win) return

  if (!open) openedAt = Date.now()
  open = true
  const send = () => win.webContents.send('player-menu-data', payload)
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
  else send()

  sync()
  if (!win.isVisible()) win.showInactive()

  // Above the video, which is a window of its own, but not above anything
  // outside the app
  win.moveTop()
}

function hide () {
  open = false
  const win = playerMenu.win
  if (!win || win.isDestroyed()) return
  if (win.isVisible()) win.hide()
}

// The page measures itself once it has drawn, so the panel is exactly as tall
// as what is in it
function setHeight (value) {
  height = Math.max(60, Math.min(640, Math.round(value || 0)))
  sync()
}

function sync () {
  const win = playerMenu.win
  if (!win || win.isDestroyed() || !open) return

  const main = require('./main').win
  if (!main || main.isDestroyed()) return

  const area = main.getContentBounds()

  // Above the controls, against the right-hand edge, and never taller than the
  // player itself
  const tallest = Math.max(80, area.height - config.UI_HEADER_HEIGHT - MARGIN * 2)
  const panelHeight = Math.min(height, tallest)
  const x = area.x + area.width - WIDTH - MARGIN
  const y = area.y + area.height - config.UI_PLAYER_CONTROLS_HEIGHT -
    panelHeight - MARGIN

  win.setBounds({
    x: Math.round(x),
    y: Math.round(Math.max(area.y + MARGIN, y)),
    width: WIDTH,
    height: Math.round(panelHeight)
  })
}
