const telemetry = require('../lib/telemetry')
const { dispatch } = require('../lib/dispatcher')

// How often the playback position is written down while a video plays
const SAVE_POSITION_EVERY = 5000

// Controls local play back: the <video>/<audio> tag and the embedded player
// Does not control remote casting (Chromecast etc)
module.exports = class MediaController {
  constructor (state) {
    this.state = state
    this.lastPositionSave = 0
  }

  mediaSuccess () {
    telemetry.logPlayAttempt('success')
  }

  mediaStalled () {
    this.state.playing.isStalled = true
  }

  // The image viewer finished downloading and decoding the picture
  imageLoaded () {
    this.state.playing.imageLoaded = true
    this.state.playing.isReady = true
    telemetry.logPlayAttempt('success')
  }

  imageError () {
    dispatch('error', `Couldn't show ${this.state.playing.fileName}`)
  }

  /**
   * Playback failed. Video goes through the embedded mpv engine, which plays
   * everything, so this only comes up for audio the browser cannot decode -
   * and there is no second app to send it to any more, so just say so.
   */
  mediaError (error) {
    const state = this.state
    if (state.location.url() !== 'player') return
    if (state.playing.location !== 'local') return

    telemetry.logPlayAttempt('error')
    const name = state.playing.fileName || 'that file'
    console.error('playback failed for %s: %s', name, error)
    dispatch('error', `Couldn't play ${name}`)
  }

  mediaTimeUpdate () {
    const now = new Date().getTime()
    this.state.playing.lastTimeUpdate = now
    this.state.playing.isStalled = false

    // Save how far through the video we are every few seconds, so closing the
    // app or losing power never costs more than that
    if (now - this.lastPositionSave > SAVE_POSITION_EVERY) {
      this.lastPositionSave = now
      dispatch('savePosition')
    }
  }

  mediaMouseMoved (inControls, x, y) {
    // A window appearing or going away under the pointer makes Chromium send a
    // mousemove although the pointer has not moved an inch. Counting that as
    // movement put the bars straight back up the moment they went away, so
    // they jumped up and down once or twice before settling. A move to exactly
    // where the pointer already was is no move.
    if (x != null && y != null) {
      const last = this.lastMouseAt
      if (last && last.x === x && last.y === y) return
      this.lastMouseAt = { x, y }
    }

    this.state.playing.mouseStationarySince = new Date().getTime()
    // The bars are drawn in a window of their own, which says when the
    // pointer is resting on one of them
    if (inControls !== undefined) this.state.playing.mouseInControls = !!inControls
  }

  // The bars gave up the pointer without it going anywhere the page can see,
  // because their window lost the focus. They are free to go, and the wait
  // before they do is not started again.
  controlsPointerGone () {
    this.state.playing.mouseInControls = false
  }

  controlsMouseEnter () {
    this.state.playing.mouseInControls = true
    this.state.playing.mouseStationarySince = new Date().getTime()
  }

  controlsMouseLeave () {
    this.state.playing.mouseInControls = false
    this.state.playing.mouseStationarySince = new Date().getTime()
  }
}
