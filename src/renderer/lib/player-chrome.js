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

// What was last sent, so the bars are only redrawn when something changes
let last = null

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

  return {
    visible: !state.shouldHidePlayerControls(),
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
