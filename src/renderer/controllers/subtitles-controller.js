const path = require('path')
const remote = require('@electron/remote')
const { ipcRenderer } = require('electron')

const config = require('../../config')
const { dispatch } = require('../lib/dispatcher')
const MpvPlayer = require('../lib/mpv-player')

/**
 * Subtitles, handled by the embedded mpv engine.
 *
 * mpv reads .srt, .ass/.ssa, .vtt and .sub directly, keeps ASS styling, and
 * lists whatever is embedded in the video, so there is no conversion step. This
 * controller decides what to offer in the menu, what to turn on by itself, and
 * remembers the choice for next time.
 */
module.exports = class SubtitlesController {
  constructor (state) {
    this.state = state
  }

  // Is this a subtitle file, by extension?
  isSubtitle (file) {
    const name = typeof file === 'string' ? file : file.name
    return config.SUBTITLE_EXTENSIONS.includes(path.extname(name).toLowerCase())
  }

  /**
   * Works out which subtitle files in the torrent are worth offering, with the
   * most likely ones first: same name as the video, then same folder, then the
   * rest of the torrent.
   */
  checkForSubtitles () {
    const state = this.state
    if (state.playing.type !== 'video') return

    const torrentSummary = state.getPlayingTorrentSummary()
    const fileSummary = state.getPlayingFileSummary()
    if (!torrentSummary || !torrentSummary.files || !fileSummary) return

    const videoFolder = folderOf(fileSummary)
    const videoBase = baseName(fileSummary.name)

    const candidates = []
    torrentSummary.files.forEach((file, index) => {
      if (!this.isSubtitle(file)) return

      const sameFolder = folderOf(file) === videoFolder
      const subBase = baseName(file.name)
      // "Show.S01E01.mkv" and "Show.S01E01.en.srt" belong together
      const matchesName = subBase === videoBase ||
        subBase.startsWith(videoBase + '.') ||
        videoBase.startsWith(subBase + '.')

      candidates.push({
        index,
        name: file.name,
        length: file.length,
        sameFolder,
        matchesName,
        score: (matchesName ? 2 : 0) + (sameFolder ? 1 : 0)
      })
    })

    candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

    // Anything from elsewhere in the torrent is noise once there are good
    // matches, so only keep those when nothing matches
    const best = candidates.filter(c => c.score > 0)
    state.playing.subtitleFiles = (best.length > 0 ? best : candidates).slice(0, 25)

    this.autoSelectSubtitle()
  }

  /**
   * Turns on a sensible subtitle without being asked: the one the user chose
   * for this video before, otherwise their usual language, otherwise a
   * subtitle file named after the video, otherwise an English track.
   */
  autoSelectSubtitle () {
    const state = this.state
    const fileSummary = state.getPlayingFileSummary()
    if (!fileSummary) return

    // The user turned subtitles off and meant it
    if (state.saved.prefs.subtitlesEnabled === false) return

    const choice = fileSummary.subtitleChoice
    if (choice) {
      if (choice.type === 'off') return
      if (choice.type === 'file' && choice.index != null) {
        return this.selectTorrentSubtitle(choice.index)
      }
      if (choice.type === 'external' && choice.filePath) {
        return MpvPlayer.addSubtitleFile(choice.filePath, path.basename(choice.filePath))
      }
      if (choice.type === 'track' && choice.language) {
        return this.selectTrackByLanguage(choice.language)
      }
    }

    // A subtitle file named after the video is almost always the right one
    const named = (state.playing.subtitleFiles || []).find(f => f.matchesName)
    if (named) return this.selectTorrentSubtitle(named.index)

    const language = state.saved.prefs.subtitleLanguage || 'en'
    this.selectTrackByLanguage(language)
  }

  // Picks an embedded track by language, if the video has one
  selectTrackByLanguage (language) {
    const tracks = this.state.playing.subtitles.tracks || []
    const wanted = String(language).slice(0, 2).toLowerCase()
    const match = tracks.find(t => (t.language || '').slice(0, 2).toLowerCase() === wanted)
    if (!match) return false

    MpvPlayer.setSubtitleTrack(match.id)
    return true
  }

  // Picks one of mpv's tracks from the menu
  selectSubtitle (index) {
    const state = this.state
    const tracks = state.playing.subtitles.tracks || []
    state.playing.openMenu = null

    if (index === -1 || !tracks[index]) {
      MpvPlayer.setSubtitleTrack(null)
      state.playing.subtitles.selectedIndex = -1
      this.rememberChoice({ type: 'off' })
      state.saved.prefs.subtitlesEnabled = false
    } else {
      const track = tracks[index]
      MpvPlayer.setSubtitleTrack(track.id)
      state.playing.subtitles.selectedIndex = index
      state.saved.prefs.subtitlesEnabled = true
      if (track.language) state.saved.prefs.subtitleLanguage = track.language
      this.rememberChoice(track.external && track.filePath
        ? { type: 'external', filePath: track.filePath }
        : { type: 'track', language: track.language || '', id: track.id })
    }

    dispatch('stateSave')
  }

  /**
   * Downloads one subtitle file out of the torrent - just that file, nothing
   * else - and hands it to mpv once it has arrived.
   */
  selectTorrentSubtitle (index) {
    const state = this.state
    const torrentSummary = state.getPlayingTorrentSummary()
    if (!torrentSummary) return

    state.playing.pendingSubtitle = index
    state.saved.prefs.subtitlesEnabled = true
    this.rememberChoice({ type: 'file', index })

    ipcRenderer.send('wt-fetch-file', torrentSummary.infoHash, index)
    dispatch('stateSave')
  }

  // A file we asked for has finished downloading
  subtitleFileReady (infoHash, index, filePath) {
    const state = this.state
    if (state.playing.pendingSubtitle !== index) return
    state.playing.pendingSubtitle = null

    const torrentSummary = state.getPlayingTorrentSummary()
    const file = torrentSummary && torrentSummary.files[index]
    MpvPlayer.addSubtitleFile(filePath, file ? file.name : undefined)
    dispatch('update')
  }

  // "Load from my computer..."
  openSubtitles () {
    const filePaths = remote.dialog.showOpenDialogSync(remote.getCurrentWindow(), {
      title: 'Select a subtitle file',
      filters: [{
        name: 'Subtitles',
        extensions: config.SUBTITLE_EXTENSIONS.map(e => e.slice(1))
      }],
      properties: ['openFile']
    })
    if (!Array.isArray(filePaths) || filePaths.length === 0) return

    this.addSubtitles(filePaths, true)
  }

  // Subtitle files dropped onto the window, or chosen from the dialog
  addSubtitles (files, autoSelect) {
    const paths = files
      .map(file => (typeof file === 'string' ? file : file.path))
      .filter(filePath => filePath && this.isSubtitle(filePath))

    paths.forEach(filePath => MpvPlayer.addSubtitleFile(filePath, path.basename(filePath)))

    if (paths.length > 0 && autoSelect) {
      this.state.saved.prefs.subtitlesEnabled = true
      this.rememberChoice({ type: 'external', filePath: paths[paths.length - 1] })
      dispatch('stateSave')
    }
  }

  // The subtitle menu, drawn in a window of its own over the video
  toggleSubtitlesMenu () {
    const playing = this.state.playing
    playing.openMenu = playing.openMenu === 'subtitles' ? null : 'subtitles'
    playing.mouseStationarySince = new Date().getTime()
  }

  // Put the subtitles exactly this far ahead of or behind the picture
  setSubtitleDelay (seconds) {
    const playing = this.state.playing
    playing.subtitleDelay = Math.round(seconds * 100) / 100
    MpvPlayer.setSubtitleDelay(playing.subtitleDelay)

    const fileSummary = this.state.getPlayingFileSummary()
    if (fileSummary) {
      if (playing.subtitleDelay) fileSummary.subtitleDelay = playing.subtitleDelay
      else delete fileSummary.subtitleDelay
    }
    dispatch('stateSave')
  }

  // Draw the subtitles at exactly this size, 1 being the normal one
  setSubtitleScale (scale) {
    const state = this.state
    state.playing.subtitleScale = Math.max(0.3, Math.min(4, scale))
    MpvPlayer.setSubtitleScale(state.playing.subtitleScale)
    state.saved.prefs.subtitleScale = state.playing.subtitleScale
    dispatch('stateSave')
  }

  // Nudge the subtitles earlier or later, in small steps. The keyboard uses
  // this; the menu sets the delay outright.
  changeSubtitleDelay (direction) {
    const delay = (this.state.playing.subtitleDelay || 0) +
      direction * config.SUBTITLE_DELAY_STEP
    this.setSubtitleDelay(delay)
  }

  // Bigger or smaller subtitles, remembered for next time
  changeSubtitleScale (direction) {
    this.setSubtitleScale((this.state.playing.subtitleScale || 1) + direction * 0.1)
  }

  rememberChoice (choice) {
    const fileSummary = this.state.getPlayingFileSummary()
    if (fileSummary) fileSummary.subtitleChoice = choice
  }
}

function folderOf (file) {
  return String(file.path || file.name || '').split(/[\\/]/).slice(0, -1).join('/')
}

// File name without its extension, lower case, for matching video to subtitle
function baseName (name) {
  return String(name || '').replace(/\.[^.]+$/, '').toLowerCase()
}
