const { ipcRenderer } = require('electron')
const path = require('path')

const Cast = require('../lib/cast')
const { dispatch } = require('../lib/dispatcher')
const telemetry = require('../lib/telemetry')
const { UnplayableFileError, UnplayableTorrentError } = require('../lib/errors')
const sound = require('../lib/sound')
const TorrentPlayer = require('../lib/torrent-player')
const TorrentSummary = require('../lib/torrent-summary')
const Playlist = require('../lib/playlist')
const PlaybackPosition = require('../lib/playback-position')
const MpvPlayer = require('../lib/mpv-player')
const State = require('../lib/state')

// Videos play through the embedded mpv engine; audio and images stay with the
// built-in player
function usesMpv (state) {
  return state.playing.type === 'video'
}

// Controls playback of torrents and files within torrents
// both local (<video>,<audio>,external player) and remote (cast)
module.exports = class PlaybackController {
  constructor (state, config, update) {
    this.state = state
    this.config = config
    this.update = update
  }

  // Play a file in a torrent.
  // * Start torrenting, if necessary
  // * Stream, if not already fully downloaded
  // * If no file index is provided, restore the most recently viewed file or autoplay the first
  playFile (infoHash, index /* optional */) {
    this.pauseActiveTorrents(infoHash)

    const state = this.state
    if (state.location.url() === 'player') {
      this.updatePlayer(infoHash, index, false, (err) => {
        if (err) dispatch('error', err)
        else this.play()
      })
    } else {
      let initialized = false
      state.location.go({
        url: 'player',
        setup: (cb) => {
          const torrentSummary = TorrentSummary.getByKey(state, infoHash)

          if (index === undefined || initialized) index = torrentSummary.mostRecentFileIndex
          if (index == null) index = torrentSummary.files.findIndex(TorrentPlayer.isPlayable)
          if (index == null || index < 0) return cb(new UnplayableTorrentError())

          initialized = true

          this.openPlayer(infoHash, index, (err) => {
            if (!err) this.play()
            cb(err)
          })
        },
        destroy: () => this.closePlayer()
      }, (err) => {
        if (err) dispatch('error', err)
      })
    }
  }

  // Open a file in OS default app.
  openPath (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    const filePath = path.join(
      torrentSummary.path,
      torrentSummary.files[index].path)
    ipcRenderer.send('openPath', filePath)
  }

  // Toggle (play or pause) the currently playing media
  playPause () {
    const state = this.state
    if (state.location.url() !== 'player') return

    // force rerendering if window is hidden,
    // in order to bypass `raf` and play/pause media immediately
    const mediaTag = document.querySelector('video,audio')
    if (!state.window.isVisible && mediaTag) {
      if (state.playing.isPaused) mediaTag.play()
      else mediaTag.pause()
    }

    if (state.playing.isPaused) this.play()
    else this.pause()
  }

  pauseActiveTorrents (infoHash) {
    // Playback Priority: pause all active torrents if needed.
    if (!this.state.saved.prefs.highestPlaybackPriority) return

    // Do not pause active torrents if playing a fully downloaded torrent.
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (torrentSummary.status === 'seeding') return

    dispatch('prioritizeTorrent', infoHash)
  }

  // Play next file in list (if any)
  nextTrack () {
    const state = this.state
    if (Playlist.hasNext(state) && state.playing.location !== 'external') {
      this.updatePlayer(
        state.playing.infoHash, Playlist.getNextIndex(state), false, (err) => {
          if (err) dispatch('error', err)
          else this.play()
        })
    }
  }

  // Play previous track in list (if any)
  previousTrack () {
    const state = this.state
    if (Playlist.hasPrevious(state) && state.playing.location !== 'external') {
      this.updatePlayer(
        state.playing.infoHash, Playlist.getPreviousIndex(state), false, (err) => {
          if (err) dispatch('error', err)
          else this.play()
        })
    }
  }

  // Play (unpause) the current media
  play () {
    const state = this.state
    if (!state.playing.isPaused) return
    state.playing.isPaused = false
    if (isCasting(state)) {
      Cast.play()
    } else if (usesMpv(state)) {
      MpvPlayer.setPaused(false)
    }
    ipcRenderer.send('onPlayerPlay')
  }

  // Pause the currently playing media
  pause () {
    const state = this.state
    if (state.playing.isPaused) return
    state.playing.isPaused = true
    // Pausing is a good moment to write down where we got to
    this.savePosition()
    if (isCasting(state)) {
      Cast.pause()
    } else if (usesMpv(state)) {
      MpvPlayer.setPaused(true)
    }
    ipcRenderer.send('onPlayerPause')
  }

  // Skip specified number of seconds (backwards if negative)
  skip (time) {
    this.skipTo(this.state.playing.currentTime + time)
  }

  // Skip (aka seek) to a specific point, in seconds
  skipTo (time) {
    if (!Number.isFinite(time)) {
      console.error('Tried to skip to a non-finite time ' + time)
      return console.trace()
    }
    if (isCasting(this.state)) Cast.seek(time)
    else if (usesMpv(this.state)) MpvPlayer.seek(time)
    else this.state.playing.jumpToTime = time
  }

  // Show video preview
  preview (x) {
    if (!Number.isFinite(x)) {
      console.error('Tried to preview a non-finite position ' + x)
      return console.trace()
    }
    this.state.playing.previewXCoord = x
  }

  // Hide video preview
  clearPreview () {
    this.state.playing.previewXCoord = null
  }

  // Step through the speeds offered by the speed menu. 1 = faster, -1 = slower.
  // The < and > keys and the menu therefore always agree on the current speed.
  changePlaybackRate (direction) {
    const rates = this.config.PLAYBACK_RATES
    const current = this.state.playing.playbackRate

    // Where are we now? If the speed is not one of the presets (an old config,
    // say), start from whichever preset is closest.
    let index = rates.indexOf(current)
    if (index === -1) {
      index = rates.reduce((best, rate, i) =>
        Math.abs(rate - current) < Math.abs(rates[best] - current) ? i : best, 0)
    } else {
      index += direction > 0 ? 1 : -1
    }

    this.setPlaybackRate(rates[Math.max(0, Math.min(rates.length - 1, index))])
  }

  // Set an exact playback speed, for this video only: the next one starts at
  // normal speed again
  setPlaybackRate (rate) {
    const state = this.state

    state.playing.playbackRate = rate
    if (isCasting(state) && !Cast.setRate(rate)) {
      state.playing.playbackRate = 1
    } else if (usesMpv(state)) {
      MpvPlayer.setSpeed(state.playing.playbackRate)
    }

    dispatch('update')

    // Wait a bit before we hide the controls and header again
    state.playing.mouseStationarySince = new Date().getTime()
  }

  // The speed menu, drawn in a window of its own over the video
  togglePlaybackRateMenu () {
    const playing = this.state.playing
    playing.openMenu = playing.openMenu === 'speed' ? null : 'speed'
    playing.mouseStationarySince = new Date().getTime()
  }

  // Change the volume, in range [0, 1], by some amount
  // For example, volume muted (0), changeVolume (0.3) increases to 30% volume
  changeVolume (delta) {
    // change volume with delta value
    this.setVolume(this.state.playing.volume + delta)
  }

  // Set the volume to some value in [0, 1]
  setVolume (volume) {
    // check if its in [0.0 - 1.0] range
    volume = Math.max(0, Math.min(1, volume))

    const state = this.state
    if (isCasting(state)) {
      Cast.setVolume(volume)
    } else if (usesMpv(state)) {
      state.playing.volume = volume
      MpvPlayer.setVolume(volume)
    } else {
      state.playing.setVolume = volume
    }
  }

  // Hide player controls while playing video, if the mouse stays still for a while
  // Never hide the controls when:
  // * The mouse is over the controls or we're scrubbing (see CSS)
  // * The video is paused
  // * The video is playing remotely on Chromecast or Airplay
  showOrHidePlayerControls () {
    const state = this.state
    const hideControls = state.shouldHidePlayerControls()

    if (hideControls !== state.playing.hideControls) {
      state.playing.hideControls = hideControls
      return true
    }
    return false
  }

  // Opens the video player to a specific torrent
  openPlayer (infoHash, index, cb) {
    const state = this.state
    const torrentSummary = TorrentSummary.getByKey(state, infoHash)

    state.playing.infoHash = torrentSummary.infoHash
    state.playing.isReady = false

    // Every video starts at normal speed: a speed picked for one video is
    // rarely what the next one wants
    state.playing.playbackRate = 1

    // update UI to show pending playback
    sound.play('PLAY')

    // Select the file BEFORE starting the torrent, so that starting it can
    // never download anything other than the file being opened
    this.streamOnlyFile(torrentSummary, index)

    this.startServer(torrentSummary)
    ipcRenderer.send('onPlayerOpen')
    this.updatePlayer(infoHash, index, true, cb)
  }

  // Starts WebTorrent server for media streaming.
  // Starting a torrent is idempotent: if it is already running, the WebTorrent
  // process keeps it - along with everything it has already downloaded - and
  // just re-points it at the file we want, then reports ready again.
  startServer (torrentSummary) {
    const state = this.state

    ipcRenderer.once('wt-ready-' + torrentSummary.infoHash, () => onTorrentReady())
    dispatch('startTorrentingSummary', torrentSummary.torrentKey)

    function onTorrentReady () {
      ipcRenderer.send('wt-start-server', torrentSummary.infoHash)
      ipcRenderer.once('wt-server-running', () => { state.playing.isReady = true })
    }
  }

  // Downloads exactly one file of one torrent, and nothing else.
  // Whatever was being previewed before is deselected and its data deleted.
  streamOnlyFile (torrentSummary, index) {
    const state = this.state
    const infoHash = torrentSummary.infoHash
    const previous = state.streaming

    // Moving to a file in another torrent? Stop that one downloading, but keep
    // what it already fetched, so going back to it is instant.
    if (previous && previous.infoHash !== infoHash) {
      const previousSummary = TorrentSummary.getByKey(state, previous.infoHash)
      const previousPreloads = state.preloads.get(previous.infoHash)
      if (previousSummary && previousSummary.files) {
        // Anything the user asked for ahead of time keeps downloading
        previousSummary.selections = previousSummary.files.map(
          (file, i) => !!previousPreloads && previousPreloads.has(i))
        if (!previousSummary.selections.some(Boolean)) {
          previousSummary.status = 'paused'
        }
      }
      if (!previousPreloads || previousPreloads.size === 0) {
        ipcRenderer.send('wt-stop-downloading', previous.infoHash)
      } else {
        ipcRenderer.send('wt-select-files', previous.infoHash,
          previousSummary.selections)
      }
    }

    // Selecting just this file is also what stops the previous file in the same
    // torrent from downloading any further
    const preloads = state.preloads.get(infoHash)
    torrentSummary.selections = torrentSummary.files.map(
      (file, i) => i === index || (!!preloads && preloads.has(i)))
    state.streaming = { infoHash, fileIndex: index }

    // A torrent that is asleep picks the selections up when it is started, by
    // way of startTorrentingSummary
    if (torrentSummary.status !== 'paused') {
      ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
    }
    torrentSummary.status = 'downloading'
  }

  // Called each time the current file changes
  updatePlayer (infoHash, index, resume, cb) {
    const state = this.state

    const torrentSummary = TorrentSummary.getByKey(state, infoHash)

    // No file asked for, e.g. the play button on the torrent itself was pressed
    // while the player was already open. Pick up where we left off, or start at
    // the first file we can show.
    if (index == null) {
      index = torrentSummary.mostRecentFileIndex
      if (index == null) index = torrentSummary.files.findIndex(TorrentPlayer.isPlayable)
    }

    const fileSummary = torrentSummary.files[index]

    if (!fileSummary || !TorrentPlayer.isPlayable(fileSummary)) {
      torrentSummary.mostRecentFileIndex = undefined
      return cb(new UnplayableFileError())
    }

    torrentSummary.mostRecentFileIndex = index

    // Switching to a file in a different torrent tears the old torrent down,
    // and the streaming server belongs to it, so the new torrent needs one
    const switchedTorrent = state.playing.infoHash && state.playing.infoHash !== infoHash

    // Download this file and only this file
    this.streamOnlyFile(torrentSummary, index)

    if (switchedTorrent) {
      state.server = null
      state.playing.isReady = false
      this.startServer(torrentSummary)
    }

    // Remember where the user was, so the list can show it when they come back
    fileSummary.played = true
    fileSummary.lastPlayedAt = Date.now()
    state.lastPlayed = { infoHash, fileIndex: index }
    dispatch('stateSave')

    // update state
    state.playing.infoHash = infoHash
    state.playing.fileIndex = index
    state.playing.fileName = fileSummary.name
    state.playing.type = TorrentPlayer.isVideo(fileSummary)
      ? 'video'
      : TorrentPlayer.isAudio(fileSummary)
        ? 'audio'
        : TorrentPlayer.isImage(fileSummary)
          ? 'image'
          : 'other'

    // Each picture has to be fetched before it can be shown, so the viewer
    // starts out waiting again every time the user steps to another one
    if (state.playing.type === 'image') state.playing.imageLoaded = false

    // Pick up where we left off, a few seconds earlier for context. This
    // applies whether or not the file is still in the temp folder: the position
    // is saved alongside the magnet link, not with the downloaded data.
    const resumeTime = PlaybackPosition.getResumeTime(fileSummary)
    state.playing.jumpToTime = resumeTime

    // Tell the user we did it, and offer to start from the beginning instead
    state.playing.resumedFrom = resumeTime > 0 ? fileSummary.currentTime : null

    if (resumeTime > 0) {
      // Fetch the pieces around the resume point first, rather than starting
      // the download at the beginning of a file we are not going to watch yet
      ipcRenderer.send('wt-prioritize-position',
        infoHash, index, resumeTime, fileSummary.duration)
    }

    // Put back the audio track, subtitle and subtitle timing chosen for this
    // video last time
    if (typeof fileSummary.audioTrack === 'number') {
      state.playing.audioTracks.selectedIndex = fileSummary.audioTrack
    }
    if (typeof fileSummary.subtitleDelay === 'number') {
      state.playing.subtitleDelay = fileSummary.subtitleDelay
    }

    // if it's audio, parse out the metadata (artist, title, etc)
    if (torrentSummary.status === 'paused') {
      ipcRenderer.once('wt-ready-' + torrentSummary.infoHash, getAudioMetadata)
    } else {
      getAudioMetadata()
    }

    function getAudioMetadata () {
      if (state.playing.type === 'audio') {
        ipcRenderer.send('wt-get-audio-metadata', torrentSummary.infoHash, index)
      }
    }

    // if it's video, check for subtitles files that are done downloading
    dispatch('checkForSubtitles')

    // enable previously selected subtitle track
    if (fileSummary.selectedSubtitle) {
      dispatch('addSubtitles', [fileSummary.selectedSubtitle], true)
    }

    state.window.title = fileSummary.name

    // Video plays through the embedded mpv engine, which handles every format
    // the built-in player cannot: HEVC, EAC3, .avi, .wmv and the rest
    if (usesMpv(state)) {
      state.playing.mpvLoadedUrl = null
      state.playing.mpvLoaded = false
      if (!MpvPlayer.isOpen()) MpvPlayer.open(state)
      this.loadIntoMpv()
    }

    this.update()

    ipcRenderer.send('onPlayerUpdate', Playlist.hasNext(state), Playlist.hasPrevious(state))
    cb()
  }

  closePlayer () {
    console.log('closePlayer')

    // Quit any external players, like Chromecast/Airplay/etc or VLC
    const state = this.state
    if (isCasting(state)) {
      Cast.stop()
    }

    // Save volume (this session only, not in state.saved)
    state.previousVolume = state.playing.volume

    if (!state.playing.isReady) telemetry.logPlayAttempt('abandoned') // user gave up waiting

    // Write down where we got to before the playing state is thrown away
    this.savePosition()

    // Shut the video engine down and take its window away. This also makes sure
    // mpv has let go of the file before the temp folder is cleared.
    MpvPlayer.close()

    // Stop downloading the file we were watching. What has already been
    // fetched stays in the temp folder until the app quits, so reopening it
    // plays straight away.
    this.stopDownloading()

    // Reset the window contents back to the home screen
    state.playing = State.getDefaultPlayState()
    state.server = null

    // Reset the window size and location back to where it was
    if (state.window.isFullScreen) {
      dispatch('toggleFullScreen', false)
    }
    restoreBounds(state)

    ipcRenderer.send('onPlayerClose')

    // Playback Priority: resume previously paused downloads.
    if (this.state.saved.prefs.highestPlaybackPriority) {
      dispatch('resumePausedTorrents')
    }

    dispatch('stateSave')
    this.update()
  }

  /**
   * Hands the file to mpv, once both the engine and the torrent-to-HTTP server
   * are ready. Called again as each of those becomes available, and whenever
   * the file changes; it does nothing until it has everything it needs.
   */
  loadIntoMpv () {
    const state = this.state
    if (!usesMpv(state) || !state.playing.mpvReady || !state.server) return

    const url = Playlist.getCurrentLocalURL(state)
    if (!url || url === state.playing.mpvLoadedUrl) return

    const fileSummary = state.getPlayingFileSummary()
    state.playing.mpvLoadedUrl = url

    // mpv streams from the same local HTTP server the built-in player used, so
    // only the file being watched is downloaded, and it plays while it arrives
    MpvPlayer.load(url, {
      start: state.playing.jumpToTime > 0 ? state.playing.jumpToTime : undefined,
      speed: state.playing.playbackRate,
      volume: Math.round(state.playing.volume * 100),
      'sub-delay': state.playing.subtitleDelay || 0,
      'sub-scale': state.playing.subtitleScale || 1,
      aid: fileSummary && fileSummary.audioTrack != null ? fileSummary.audioTrack : undefined,
      pause: state.playing.isPaused ? 'yes' : 'no'
    })
  }

  // mpv has started up and is waiting for something to play
  mpvReady () {
    this.state.playing.mpvReady = true
    this.loadIntoMpv()
    this.update()
  }

  // The video reached its end
  mpvEnded () {
    const state = this.state
    if (Playlist.hasNext(state)) {
      this.nextTrack()
    } else {
      dispatch('backToList')
    }
  }

  /**
   * Writes down where the user has got to in the current video, so it can be
   * resumed later. Called every few seconds while playing, on pause, when
   * switching files, when the player closes and when the app quits.
   */
  savePosition () {
    const state = this.state
    const fileSummary = state.getPlayingFileSummary()
    if (!fileSummary) return

    const justFinished = PlaybackPosition.recordPosition(
      fileSummary, state.playing.currentTime, state.playing.duration)

    // Remember the audio track and subtitle timing chosen for this video
    if (state.playing.audioTracks.tracks.length > 1) {
      fileSummary.audioTrack = state.playing.audioTracks.selectedIndex
    }
    if (state.playing.subtitleDelay) {
      fileSummary.subtitleDelay = state.playing.subtitleDelay
    }

    if (justFinished) console.log('finished watching %s', fileSummary.name)
    dispatch('stateSave')
  }

  // The video played to the end: count it as watched and forget the position
  mediaEnded () {
    const fileSummary = this.state.getPlayingFileSummary()
    PlaybackPosition.markFinished(fileSummary)
    dispatch('stateSave')
  }

  // Start the current video again from the beginning
  startOver () {
    this.state.playing.resumedFrom = null
    this.skipTo(0)
  }

  dismissResumeNote () {
    this.state.playing.resumedFrom = null
  }

  // Stops fetching the file we were watching. The data stays in the temp folder
  // for the rest of the session, so reopening the file costs nothing; the whole
  // folder is cleared when the app quits.
  stopDownloading () {
    const state = this.state
    const streaming = state.streaming
    state.streaming = null

    const infoHash = (streaming && streaming.infoHash) || state.playing.infoHash
    if (!infoHash) {
      ipcRenderer.send('wt-stop-server')
      return
    }

    const torrentSummary = TorrentSummary.getByKey(state, infoHash)
    if (torrentSummary) {
      if (torrentSummary.files) {
        torrentSummary.selections = torrentSummary.files.map(() => false)
      }
      torrentSummary.status = 'paused'
    }

    ipcRenderer.send('wt-stop-downloading', infoHash)
  }
}

// Checks whether we are connected and already casting
// Returns false if we not casting (state.playing.location === 'local')
// or if we're trying to connect but haven't yet ('chromecast-pending', etc)
function isCasting (state) {
  return state.playing.location === 'chromecast' ||
    state.playing.location === 'airplay' ||
    state.playing.location === 'dlna'
}

function restoreBounds (state) {
  ipcRenderer.send('setAspectRatio', 0)
  if (state.window.bounds) {
    ipcRenderer.send('setBounds', state.window.bounds, false)
  }
}
