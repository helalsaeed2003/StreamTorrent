/**
 * The player's bars, drawn in a window of their own over the video.
 *
 * mpv paints into a native window that this page cannot draw on top of, so the
 * header and the controls are drawn in a window laid over it instead. This
 * decides what they show; static/player-chrome.js draws it and sends back
 * whatever the user does with them.
 */

const { ipcRenderer } = require('electron')

const Playlist = require('./playlist')

module.exports = { sync }

// How long the offer to jump back stays up
const RESUME_OFFER_MS = 15 * 1000

// What was last sent, so the bars are only redrawn when something changes
let last = null

// "12:34" or "1:02:03"
function formatPosition (seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const secs = whole % 60
  const pad = n => (n < 10 ? '0' + n : String(n))
  if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(secs)
  return minutes + ':' + pad(secs)
}

function sync (state) {
  const payload = payloadFor(state)
  const json = payload && JSON.stringify(payload)

  if (json === last) return
  last = json

  if (!payload) return ipcRenderer.send('player-chrome-hide')
  ipcRenderer.send('player-chrome-show', payload)
}

function payloadFor (state) {
  // Only while a video is playing through mpv: audio and images keep the
  // page's own controls, which nothing is covering
  if (state.location.url() !== 'player') return null
  if (state.playing.type !== 'video' || state.playing.location !== 'local') return null

  const playing = state.playing
  const fileSummary = state.getPlayingFileSummary()

  // How much of the file is here, for the bar behind the seek bar
  const torrentSummary = state.getPlayingTorrentSummary()
  const fileProgress = torrentSummary && torrentSummary.progress &&
    torrentSummary.progress.files && torrentSummary.progress.files[playing.fileIndex]
  const bufferedFraction = fileProgress && fileProgress.numPieces > 0
    ? fileProgress.numPiecesPresent / fileProgress.numPieces
    : 0

  // The offer to jump to where this video was left off, which times out
  const offer = playing.resumeOffer != null &&
    Date.now() - (playing.resumeOfferedAt || 0) < RESUME_OFFER_MS
    ? playing.resumeOffer
    : null

  return {
    visible: !state.shouldHidePlayerControls(),
    resumeOffer: offer,
    resumeText: offer == null ? '' : formatPosition(offer),
    title: (fileSummary && fileSummary.name) || playing.fileName || '',
    isPaused: playing.isPaused,
    currentTime: playing.currentTime || 0,
    duration: playing.duration || 0,
    bufferedFraction,
    volume: playing.volume,
    playbackRate: playing.playbackRate,
    isFullScreen: state.window.isFullScreen,
    hasPrevious: Playlist.hasPrevious(state),
    hasNext: Playlist.hasNext(state),
    hasSubtitles: (playing.subtitles.tracks || []).length > 0 ||
      (playing.subtitleFiles || []).length > 0,
    subtitlesOn: playing.subtitles.selectedIndex >= 0,
    hasAudioTracks: (playing.audioTracks.tracks || []).length > 1
  }
}
