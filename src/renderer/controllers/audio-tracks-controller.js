const { dispatch } = require('../lib/dispatcher')
const MpvPlayer = require('../lib/mpv-player')
const { showContextMenu } = require('../lib/context-menu')

module.exports = class AudioTracksController {
  constructor (state) {
    this.state = state
  }

  selectAudioTrack (ix) {
    const state = this.state
    const tracks = state.playing.audioTracks.tracks || []
    state.playing.audioTracks.selectedIndex = ix
    state.playing.audioTracks.showMenu = false

    if (state.playing.type === 'video') {
      // mpv switches track without interrupting playback
      const track = tracks[ix]
      MpvPlayer.setAudioTrack(track ? track.id : null)

      // Remember it for this video
      const fileSummary = state.getPlayingFileSummary()
      if (fileSummary && track) fileSummary.audioTrack = track.id
      dispatch('stateSave')
      return
    }

    dispatch('skip', 0.2) // HACK: hardcoded seek value for smooth audio change
  }

  // The audio track menu, drawn by the system so it sits above the video
  toggleAudioTracksMenu () {
    const playing = this.state.playing
    const tracks = playing.audioTracks.tracks || []
    playing.mouseStationarySince = new Date().getTime()

    if (tracks.length === 0) return

    showContextMenu(tracks.map((track, ix) => ({
      label: track.label,
      type: 'radio',
      checked: playing.audioTracks.selectedIndex === ix,
      action: 'selectAudioTrack',
      args: [ix]
    })))
  }
}
