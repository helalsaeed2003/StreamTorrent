/**
 * The player's menus: speed, subtitles and audio tracks.
 *
 * They are drawn in a window of their own, over the video, because mpv paints
 * into a native window that the page cannot draw on top of. This decides what
 * goes in them; static/player-menu.html draws it and sends back whatever the
 * user picked.
 */

const { ipcRenderer } = require('electron')

const config = require('../../config')

module.exports = { sync }

// What was last sent, so the menu is only redrawn when something it shows has
// actually changed
let last = null

function sync (state) {
  const payload = payloadFor(state)
  const json = payload && JSON.stringify(payload)

  if (json === last) return
  last = json

  if (!payload) return ipcRenderer.send('player-menu-hide')
  ipcRenderer.send('player-menu-show', payload)
}

function payloadFor (state) {
  if (state.location.url() !== 'player') return null

  const playing = state.playing
  switch (playing.openMenu) {
    case 'speed':
      return {
        kind: 'speed',
        rate: playing.playbackRate,
        rates: config.PLAYBACK_RATES
      }

    case 'subtitles':
      return {
        kind: 'subtitles',
        tracks: (playing.subtitles.tracks || []).map(track => ({ label: track.label })),
        selectedIndex: playing.subtitles.selectedIndex,
        files: (playing.subtitleFiles || []).map(file => ({
          index: file.index,
          name: file.name,
          pending: playing.pendingSubtitle === file.index
        })),
        delay: playing.subtitleDelay || 0,
        scale: playing.subtitleScale || 1
      }

    case 'audio':
      return {
        kind: 'audio',
        tracks: (playing.audioTracks.tracks || []).map(track => ({ label: track.label })),
        selectedIndex: playing.audioTracks.selectedIndex
      }

    default:
      return null
  }
}
