const { dispatch } = require('../lib/dispatcher')
const MpvPlayer = require('../lib/mpv-player')

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

  toggleAudioTracksMenu () {
    const playing = this.state.playing
    playing.audioTracks.showMenu = !playing.audioTracks.showMenu
    if (playing.audioTracks.showMenu) {
      playing.subtitles.showMenu = false
      playing.showPlaybackRateMenu = false
    }
  }
}
