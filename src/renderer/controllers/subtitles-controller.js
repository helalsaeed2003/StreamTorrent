const path = require('path')
const remote = require('@electron/remote')
const { ipcRenderer } = require('electron')

const config = require('../../config')
const { dispatch } = require('../lib/dispatcher')
const MpvPlayer = require('../lib/mpv-player')
const { showContextMenu } = require('../lib/context-menu')

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

    state.playing.subtitles.showMenu = false
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
    state.playing.subtitles.showMenu = false
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

  /**
   * The subtitle menu: tracks inside the video, subtitle files sitting in the
   * torrent, one from the user's own machine, and the timing and size controls.
   *
   * Drawn by the system, above the video, which mpv paints into a window of its
   * own that the page cannot draw on top of. Picking one of the timing or size
   * items opens the menu again, so they can be nudged several times over.
   */
  toggleSubtitlesMenu () {
    const playing = this.state.playing
    playing.mouseStationarySince = new Date().getTime()

    const subtitles = playing.subtitles
    const items = []

    if (subtitles.tracks.length > 0) {
      items.push({ label: 'In this video', enabled: false })
      subtitles.tracks.forEach((track, ix) => {
        items.push({
          label: track.label,
          type: 'radio',
          checked: subtitles.selectedIndex === ix,
          action: 'selectSubtitle',
          args: [ix]
        })
      })
    }

    const files = playing.subtitleFiles || []
    if (files.length > 0) {
      items.push({ type: 'separator' })
      items.push({ label: 'In this torrent', enabled: false })
      files.forEach(file => {
        const pending = playing.pendingSubtitle === file.index
        items.push({
          label: pending ? file.name + ' (fetching…)' : file.name,
          action: 'selectTorrentSubtitle',
          args: [file.index]
        })
      })
    }

    items.push({ type: 'separator' })
    items.push({
      label: 'Off',
      type: 'radio',
      checked: subtitles.selectedIndex === -1,
      action: 'selectSubtitle',
      args: [-1]
    })
    items.push({ label: 'Load from my computer…', action: 'openSubtitles' })

    items.push({ type: 'separator' })
    items.push({
      label: 'Delay ' + formatDelay(playing.subtitleDelay || 0),
      enabled: false
    })
    items.push({ label: 'Show earlier', action: 'changeSubtitleDelay', args: [-1, true] })
    items.push({ label: 'Show later', action: 'changeSubtitleDelay', args: [1, true] })
    items.push({ label: 'Reset timing', action: 'resetSubtitleDelay', args: [true] })

    items.push({ type: 'separator' })
    items.push({
      label: 'Size ' + Math.round((playing.subtitleScale || 1) * 100) + '%',
      enabled: false
    })
    items.push({ label: 'Smaller', action: 'changeSubtitleScale', args: [-1, true] })
    items.push({ label: 'Bigger', action: 'changeSubtitleScale', args: [1, true] })

    showContextMenu(items)
  }

  // Nudge the subtitles earlier or later, in small steps
  changeSubtitleDelay (direction, reopen) {
    const playing = this.state.playing
    const delay = (playing.subtitleDelay || 0) + direction * config.SUBTITLE_DELAY_STEP
    playing.subtitleDelay = Math.round(delay * 100) / 100
    MpvPlayer.setSubtitleDelay(playing.subtitleDelay)

    const fileSummary = this.state.getPlayingFileSummary()
    if (fileSummary) fileSummary.subtitleDelay = playing.subtitleDelay
    dispatch('stateSave')

    // Chosen from the menu, which the system closed on the way: put it back
    // up so the timing can be nudged again
    if (reopen) this.toggleSubtitlesMenu()
  }

  resetSubtitleDelay (reopen) {
    const playing = this.state.playing
    playing.subtitleDelay = 0
    MpvPlayer.setSubtitleDelay(0)
    const fileSummary = this.state.getPlayingFileSummary()
    if (fileSummary) delete fileSummary.subtitleDelay
    dispatch('stateSave')

    if (reopen) this.toggleSubtitlesMenu()
  }

  // Bigger or smaller subtitles, remembered for next time
  changeSubtitleScale (direction, reopen) {
    const state = this.state
    const scale = Math.max(0.3, Math.min(4,
      (state.playing.subtitleScale || 1) + direction * 0.1))
    state.playing.subtitleScale = Math.round(scale * 100) / 100
    MpvPlayer.setSubtitleScale(state.playing.subtitleScale)
    state.saved.prefs.subtitleScale = state.playing.subtitleScale
    dispatch('stateSave')

    if (reopen) this.toggleSubtitlesMenu()
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

// "+0.4s" / "-1.2s" / "0s"
function formatDelay (delay) {
  if (!delay) return '0s'
  return (delay > 0 ? '+' : '') + delay.toFixed(1) + 's'
}
