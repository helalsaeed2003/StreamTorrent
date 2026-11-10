/**
 * Draws the player's bars in their own window, over the video.
 *
 * The page they belong to cannot draw on top of the video, which mpv paints
 * into a native window of its own, so the bars are drawn here instead and
 * whatever the user does with them is sent back to the page.
 */

const { ipcRenderer } = require('electron')

const app = document.getElementById('app')
const controls = document.getElementById('controls')
const titleText = document.getElementById('title')

// What the page last told us
let shown = {}

// Whether the pointer is over one of the bars. While it is, this window takes
// the mouse; the rest of the time every click goes through to the video.
let overBars = false

// While the seek bar is being dragged, the time under the pointer
let scrubbing = null

ipcRenderer.on('player-chrome-data', (e, data) => draw(data))

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
  // The seek bar, and the time shown while the pointer runs along it
  parts.preview = el('div', 'scrub-preview')
  parts.preview.style.display = 'none'
  controls.appendChild(parts.preview)

  const bar = el('div', 'playback-bar')
  parts.loading = el('div', 'loading-bar')
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
    drawPreview()
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
  parts.speed = el('i', 'icon playback-rate float-right', '1x')
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

  document.getElementById('back').addEventListener('click', () => act('backToList'))

  // Moving the mouse keeps the bars awake, and decides whether this window
  // takes the mouse or lets it through
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('wheel', e => {
    act('changeVolume', (-e.deltaY | e.deltaX) / 500)
  })
}

function onMouseMove (e) {
  const onBar = !!(e.target && e.target.closest &&
    e.target.closest('.controls, .chrome-header'))

  if (onBar !== overBars) {
    overBars = onBar
    ipcRenderer.send('player-chrome-mouse', onBar)
  }

  act('mediaMouseMoved', onBar)
}

function fractionAt (x) {
  const width = document.body.clientWidth || 1
  return Math.max(0, Math.min(1, x / width))
}

function drawPreview () {
  const duration = shown.duration || 0
  if (scrubbing == null || !duration) {
    parts.preview.style.display = 'none'
    return
  }

  const width = document.body.clientWidth || 1
  const time = scrubbing * duration
  parts.preview.style.display = ''
  parts.preview.style.left =
    Math.min(Math.max(scrubbing * width - 43, 5), width - 91) + 'px'
  parts.preview.textContent = formatTime(time, duration)
}

function draw (data) {
  shown = data || {}

  app.className = 'app view-player is-win32' +
    (shown.visible ? '' : ' hide-video-controls')

  titleText.textContent = shown.title || ''

  const fraction = shown.duration > 0 ? shown.currentTime / shown.duration : 0
  parts.cursor.style.left = 'calc(' + (fraction * 100) + '% - 3px)'
  parts.loading.style.width = (shown.bufferedFraction || 0) * 100 + '%'

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

  parts.speed.textContent = (shown.playbackRate || 1) + 'x'
  parts.captions.className = 'icon closed-caption float-right' +
    (shown.subtitlesOn ? ' active' : shown.hasSubtitles ? '' : ' dim')
  parts.audio.className = 'icon audio-tracks float-right' +
    (shown.hasAudioTracks ? ' active' : ' disabled')
  parts.fullscreen.textContent = shown.isFullScreen ? 'fullscreen_exit' : 'fullscreen'

  drawPreview()
}

// Built once; drawing only updates what is in the bars
build()
