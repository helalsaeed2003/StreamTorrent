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
    state.playing.openMenu = null

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

  // The audio track menu, drawn in a window of its own over the video
  toggleAudioTracksMenu () {
    const playing = this.state.playing
    if ((playing.audioTracks.tracks || []).length === 0) return
    playing.openMenu = playing.openMenu === 'audio' ? null : 'audio'
    playing.mouseStationarySince = new Date().getTime()
  }
}
