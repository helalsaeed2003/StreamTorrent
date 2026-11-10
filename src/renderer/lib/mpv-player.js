/**
 * The renderer's side of the embedded mpv engine.
 *
 * mpv runs in the main process and draws into a window placed over the video
 * area of the player page. This module turns that into something the rest of
 * the app can use like the old <video> tag: it sends commands one way and keeps
 * state.playing up to date from the properties mpv reports back.
 */

module.exports = {
  init,
  open,
  close,
  load,
  setPaused,
  seek,
  seekRelative,
  setVolume,
  setSpeed,
  setAudioTrack,
  setSubtitleTrack,
  addSubtitleFile,
  setSubtitleDelay,
  setSubtitleScale,
  updateInsets,
  isOpen
}

const { ipcRenderer } = require('electron')

const { dispatch } = require('./dispatcher')

// How close to the end of a video counts as having reached the end, in seconds
const END_OF_VIDEO_SECONDS = 5

let state = null
let update = () => {}
let open_ = false
// Counts how many times the player has been opened, so that a late reply about
// an earlier one can be told apart from the current one
let session = 0
let lastInsets = { top: -1, bottom: -1 }

// Anything that arrives before the player page is ready would be about the
// video we just closed, so it is ignored
function playing () {
  return state && state.location.url() === 'player' ? state.playing : null
}

function isOpen () {
  return open_
}

function init (_state, _update) {
  state = _state
  update = _update || (() => {})

  ipcRenderer.on('mpv-ready', (e, readySession) => {
    if (readySession !== undefined && readySession !== session) return
    const p = playing()
    if (!p) return
    p.mpvReady = true
    // The controls may have shown or hidden while mpv was starting, so make
    // sure the video window is the shape the page expects
    updateInsets(state)
    dispatch('mpvReady')
  })

  ipcRenderer.on('mpv-error', (e, message) => {
    console.error('mpv:', message)
    dispatch('error', message)
  })

  // Closing takes a moment. If another video was started in the meantime this
  // news is about the previous player, and acting on it would leave the app
  // thinking the video engine is shut when it is in fact playing - which stops
  // the video window being resized around the controls.
  ipcRenderer.on('mpv-closed', (e, closedSession) => {
    if (closedSession !== undefined && closedSession !== session) return
    open_ = false
  })

  ipcRenderer.on('mpv-property', (e, name, value) => onProperty(name, value))
  ipcRenderer.on('mpv-event', (e, name, data) => onEvent(name, data))
}

function onProperty (name, value) {
  const p = playing()
  if (!p) return

  switch (name) {
    case 'time-pos':
      if (typeof value === 'number') {
        p.currentTime = value
        p.lastTimeUpdate = Date.now()
        p.isStalled = false
        dispatch('mediaTimeUpdate')
      }
      return

    case 'duration':
      if (typeof value === 'number' && value > 0) p.duration = value
      break

    case 'pause':
      if (typeof value === 'boolean') p.isPaused = value
      break

    case 'eof-reached':
      // mpv also reports the end of the file when it runs out of downloaded
      // data in the middle of a video - after a seek into a part of the
      // torrent that has not arrived yet, for instance. Only count it as
      // "watched to the end" when we really are at the end; otherwise the
      // video is just waiting for more of the download.
      if (value === true) {
        const nearEnd = p.duration > 0 &&
          p.currentTime >= p.duration - END_OF_VIDEO_SECONDS
        if (nearEnd) {
          dispatch('mediaEnded')
          dispatch('mpvEnded')
        } else {
          p.isStalled = true
          dispatch('update')
        }
      }
      return

    case 'track-list':
      applyTrackList(p, value)
      break

    case 'aid':
      p.audioTracks.selectedIndex = indexOfTrack(p.audioTracks.tracks, value)
      break

    case 'sid':
      p.subtitles.selectedIndex = value === false || value == null
        ? -1
        : indexOfTrack(p.subtitles.tracks, value)
      break

    case 'volume':
      if (typeof value === 'number') p.volume = Math.max(0, Math.min(1, value / 100))
      break

    case 'speed':
      if (typeof value === 'number') p.playbackRate = value
      break

    case 'sub-delay':
      if (typeof value === 'number') p.subtitleDelay = value
      break

    case 'sub-scale':
      if (typeof value === 'number') p.subtitleScale = value
      break

    case 'paused-for-cache':
      p.isStalled = value === true
      break

    case 'width':
      p.videoWidth = value
      break

    case 'height':
      p.videoHeight = value
      break

    default:
      return
  }

  update()
}

function onEvent (name) {
  const p = playing()
  if (!p) return

  if (name === 'file-loaded') {
    p.isReady = true
    p.mpvLoaded = true
    dispatch('mediaSuccess')
    update()
  } else if (name === 'playback-restart') {
    p.isStalled = false
    update()
  }
}

// mpv reports every stream in one list; split it into what our menus show
function applyTrackList (p, tracks) {
  if (!Array.isArray(tracks)) return

  p.audioTracks.tracks = tracks
    .filter(t => t.type === 'audio')
    .map(t => ({
      id: t.id,
      label: describeTrack(t, 'Audio'),
      language: t.lang || ''
    }))

  // Subtitles embedded in the file. Ones loaded from a file of their own are
  // in here too once mpv has them, flagged as external.
  p.subtitles.tracks = tracks
    .filter(t => t.type === 'sub')
    .map(t => ({
      id: t.id,
      label: describeTrack(t, 'Subtitle'),
      language: t.lang || '',
      external: !!t.external,
      filePath: t['external-filename'] || null
    }))
}

function describeTrack (track, kind) {
  const parts = []
  if (track.lang) parts.push(languageName(track.lang))
  if (track.title) parts.push(track.title)
  if (parts.length === 0) parts.push(`${kind} ${track.id}`)
  if (track.codec && kind === 'Audio') parts.push(`(${track.codec})`)
  if (track.external) parts.push('(file)')
  return parts.join(' · ')
}

// Turn an ISO code into something readable, falling back to the code itself
let languageNames = null
function languageName (code) {
  if (!code) return ''
  try {
    if (!languageNames) languageNames = require('iso-639-1')
    const name = languageNames.getName(code.slice(0, 2))
    if (name) return name
  } catch (err) {}
  return code
}

function indexOfTrack (tracks, id) {
  if (id == null || id === false) return -1
  return tracks.findIndex(t => t.id === id)
}

// --- commands ------------------------------------------------------------

/**
 * Where the video sits in the window.
 *
 * In a window it is always the same place, whether the controls are on screen
 * or not: mpv draws in a window of its own, so moving it would resize the
 * picture every time the mouse stopped. The strip left free at the bottom
 * holds the controls and the time shown while scrubbing, and the one at the
 * top holds the header.
 *
 * Full screen is for watching, so there the picture takes the whole screen
 * and only gives the strip back while the controls are showing.
 */
function insetsFor (state) {
  // The picture takes the whole window. The header and the controls are
  // drawn over it, in a window of their own, so nothing has to be left free
  // for them and the picture never changes size.
  return { top: 0, bottom: 0 }
}

function open (state) {
  open_ = true
  session++
  lastInsets = insetsFor(state)
  ipcRenderer.send('mpv-open', lastInsets, session)
}

/**
 * Tells the video window what shape to be, whenever that has changed.
 *
 * Safe to call as often as we like: it only sends something when the answer
 * is different from last time. It has to work that way, because the one event
 * that says "the controls just appeared" is consumed by whoever notices it
 * first, and the video window must be resized either way.
 */
function updateInsets (state) {
  if (!open_) return
  const insets = insetsFor(state)
  if (insets.top === lastInsets.top && insets.bottom === lastInsets.bottom) return
  lastInsets = insets
  ipcRenderer.send('mpv-set-insets', insets)
}

function close () {
  if (!open_) return
  open_ = false
  lastInsets = { top: -1, bottom: -1 }
  ipcRenderer.send('mpv-close', session)
}

function load (url, options) {
  ipcRenderer.send('mpv-load', url, options || {})
}

function command (args) {
  ipcRenderer.send('mpv-command', args)
}

function setProperty (name, value) {
  ipcRenderer.send('mpv-set-property', name, value)
}

function setPaused (paused) {
  setProperty('pause', !!paused)
}

function seek (seconds) {
  if (!isFinite(seconds)) return
  command(['seek', Math.max(0, seconds), 'absolute'])
}

function seekRelative (seconds) {
  if (!isFinite(seconds)) return
  command(['seek', seconds, 'relative'])
}

function setVolume (volume) {
  setProperty('volume', Math.round(Math.max(0, Math.min(1, volume)) * 100))
}

function setSpeed (speed) {
  setProperty('speed', speed)
}

function setAudioTrack (id) {
  setProperty('aid', id == null ? 'no' : id)
}

function setSubtitleTrack (id) {
  setProperty('sid', id == null ? 'no' : id)
}

// Loads a subtitle file and switches to it
function addSubtitleFile (filePath, title) {
  command(title
    ? ['sub-add', filePath, 'select', title]
    : ['sub-add', filePath, 'select'])
}

function setSubtitleDelay (seconds) {
  setProperty('sub-delay', Number(seconds.toFixed(2)))
}

function setSubtitleScale (scale) {
  setProperty('sub-scale', Number(scale.toFixed(2)))
}
