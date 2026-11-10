/**
 * Draws the player's bars in their own window, over the video.
 *
 * The page they belong to cannot draw on top of the video, which mpv paints
 * into a native window of its own, so the bars are drawn here instead and
 * whatever the user does with them is sent back to the page.
 */

const { ipcRenderer } = require('electron')

// Which bar this window is drawing: the header at the top, or the controls at
// the bottom
const part = new URLSearchParams(window.location.search).get('part') || 'controls'
document.body.classList.add('part-' + part)

const headerBar = document.getElementById('header')
const controlsBar = document.getElementById('controls')
const tip = document.getElementById('tip')

// Each window keeps only its own half of the page
if (part === 'preview') {
  document.getElementById('app').remove()
} else {
  tip.remove()
  if (part === 'header') controlsBar.remove()
  else headerBar.remove()
}

const app = document.getElementById('app')
const controls = controlsBar
const titleText = document.getElementById('title')

// What the page last told us
let shown = {}

// While the seek bar is being dragged, the time under the pointer
let scrubbing = null

ipcRenderer.on('player-chrome-data', (e, data) => draw(data))
ipcRenderer.on('player-chrome-preview', (e, text) => { tip.textContent = text })

function act (action, ...args) {
  ipcRenderer.send('player-chrome-action', action, args)
}

function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function icon (name, className, title, onClick) {
  const node = el('i', 'icon ' + className, name)
  if (title) node.title = title
  if (onClick) node.addEventListener('click', onClick)
  return node
}

// "12:34" or "1:02:03"
function formatTime (seconds, total) {
  if (!Number.isFinite(seconds)) return '0:00'
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = n => (n < 10 ? '0' + n : String(n))
  const longest = Number.isFinite(total) ? total : seconds
  if (hours > 0 || longest >= 3600) return hours + ':' + pad(minutes) + ':' + pad(secs)
  return minutes + ':' + pad(secs)
}

// The bars, built once; drawing only updates what is in them
const parts = {}

function build () {
  if (part === 'preview') return
  if (part === 'header') return buildHeader()

  const bar = el('div', 'playback-bar')
  parts.loading = el('div', 'loading-bar')
  // The red part of the track: how much of the file is here to play
  parts.loaded = el('div', 'loading-bar-part')
  parts.loading.appendChild(parts.loaded)
  parts.cursor = el('div', 'playback-cursor')
  parts.scrub = el('div', 'scrub-bar')
  bar.appendChild(parts.loading)
  bar.appendChild(parts.cursor)
  bar.appendChild(parts.scrub)
  controls.appendChild(bar)

  parts.scrub.addEventListener('mousemove', e => {
    scrubbing = fractionAt(e.clientX)
    drawPreview()
  })
  parts.scrub.addEventListener('mouseout', () => {
    scrubbing = null
    hover(false)
  })
  parts.scrub.addEventListener('mousedown', e => {
    act('skipTo', fractionAt(e.clientX) * (shown.duration || 0))
  })

  parts.previous = icon('skip_previous', 'skip-previous float-left', 'Previous',
    () => act('previousTrack'))
  parts.playPause = icon('play_arrow', 'play-pause float-left', 'Play or pause',
    () => act('playPause'))
  parts.next = icon('skip_next', 'skip-next float-left', 'Next',
    () => act('nextTrack'))
  parts.volume = icon('volume_up', 'volume float-left', 'Mute',
    () => act('setVolume', shown.volume === 0 ? 1 : 0))

  parts.volumeSlider = document.createElement('input')
  parts.volumeSlider.className = 'volume-slider float-left'
  parts.volumeSlider.type = 'range'
  parts.volumeSlider.min = 0
  parts.volumeSlider.max = 1
  parts.volumeSlider.step = 0.05
  parts.volumeSlider.addEventListener('input',
    () => act('setVolume', Number(parts.volumeSlider.value)))

  parts.time = el('span', 'time float-left')

  parts.fullscreen = icon('fullscreen', 'fullscreen float-right', 'Full screen',
    () => act('toggleFullScreen'))
  // Not an "icon": it says "1x", so it is drawn in the ordinary typeface and
  // is not cut to the width of an icon
  parts.speed = el('i', 'playback-rate float-right', '1x')
  parts.speed.title = 'Playback speed'
  parts.speed.addEventListener('click', () => act('togglePlaybackRateMenu'))
  parts.captions = icon('closed_caption', 'closed-caption float-right', 'Subtitles',
    () => act('toggleSubtitlesMenu'))
  parts.audio = icon('library_music', 'audio-tracks float-right', 'Audio track',
    () => act('toggleAudioTracksMenu'))

  controls.appendChild(parts.previous)
  controls.appendChild(parts.playPause)
  controls.appendChild(parts.next)
  controls.appendChild(parts.volume)
  controls.appendChild(parts.volumeSlider)
  controls.appendChild(parts.time)
  controls.appendChild(parts.fullscreen)
  controls.appendChild(parts.speed)
  controls.appendChild(parts.captions)
  controls.appendChild(parts.audio)

  listen()
}

// The header is just the way back and the name of what is playing
function buildHeader () {
  document.getElementById('back').addEventListener('click', () => act('backToList'))
  listen()
}

function listen () {
  // These windows never take focus, so the app can still be in the background
  // when one of their buttons is pressed. Bring it forward first: a menu that
  // opens while the app is not the active one is put away again the moment
  // the focus settles, which looks like a button that does nothing.
  window.addEventListener('mousedown', () => ipcRenderer.send('player-chrome-focus'), true)

  // The pointer being on a bar keeps the bars up
  window.addEventListener('mousemove', () => act('mediaMouseMoved', true))

  // ...and once it leaves, they are free to go again. Without this the bars
  // would stay up for good, since the picture below them is mpv's own window
  // and sends the page no events of its own
  document.addEventListener('mouseleave', () => {
    act('mediaMouseMoved', false)
    if (part === 'controls') {
      scrubbing = null
      hover(false)
    }
  })
  window.addEventListener('blur', () => act('mediaMouseMoved', false))
  window.addEventListener('wheel', e => {
    act('changeVolume', (-e.deltaY | e.deltaX) / 500)
  })
}

// Whether the time under the pointer is showing
let hovering = false

function hover (on) {
  if (hovering === !!on) return
  hovering = !!on
  ipcRenderer.send('player-chrome-hover', { on: hovering })
}

function fractionAt (x) {
  const width = document.body.clientWidth || 1
  return Math.max(0, Math.min(1, x / width))
}

/**
 * Tells the main process where the pointer is on the seek bar and what the
 * time there is. It shows that in a small window just above the bar, so the
 * bar itself never has to make room and never changes size.
 */
function drawPreview () {
  const duration = shown.duration || 0

  if (scrubbing == null || !duration) {
    hover(false)
    return
  }

  const width = document.body.clientWidth || 1
  ipcRenderer.send('player-chrome-hover', {
    on: true,
    x: Math.round(scrubbing * width),
    text: formatTime(scrubbing * duration, duration)
  })
  hovering = true
}

function draw (data) {
  shown = data || {}

  app.className = 'app view-player is-win32' +
    (shown.visible ? '' : ' hide-video-controls')

  if (part === 'header') {
    titleText.textContent = shown.title || ''
    return
  }

  const fraction = shown.duration > 0 ? shown.currentTime / shown.duration : 0
  parts.cursor.style.left = 'calc(' + (fraction * 100) + '% - 3px)'
  parts.loaded.style.width = (shown.bufferedFraction || 0) * 100 + '%'

  // Nothing is under the pointer once the bars are gone
  if (!shown.visible && hovering) hover(false)

  parts.playPause.textContent = shown.isPaused ? 'play_arrow' : 'pause'
  parts.previous.className = 'icon skip-previous float-left' +
    (shown.hasPrevious ? '' : ' disabled')
  parts.next.className = 'icon skip-next float-left' +
    (shown.hasNext ? '' : ' disabled')

  const volume = shown.volume == null ? 1 : shown.volume
  parts.volume.textContent = volume === 0
    ? 'volume_off'
    : volume < 0.3 ? 'volume_mute' : volume < 0.6 ? 'volume_down' : 'volume_up'
  if (document.activeElement !== parts.volumeSlider) parts.volumeSlider.value = volume

  parts.time.textContent = formatTime(shown.currentTime, shown.duration) +
    ' / ' + formatTime(shown.duration, shown.duration)

  const rate = shown.playbackRate || 1
  parts.speed.textContent = rate + 'x'
  parts.speed.className = 'playback-rate float-right' + (rate !== 1 ? ' active' : '')
  parts.captions.className = 'icon closed-caption float-right' +
    (shown.subtitlesOn ? ' active' : shown.hasSubtitles ? '' : ' dim')
  parts.audio.className = 'icon audio-tracks float-right' +
    (shown.hasAudioTracks ? ' active' : ' disabled')
  parts.fullscreen.textContent = shown.isFullScreen ? 'fullscreen_exit' : 'fullscreen'

  drawPreview()
}

// Built once; drawing only updates what is in the bars
build()
