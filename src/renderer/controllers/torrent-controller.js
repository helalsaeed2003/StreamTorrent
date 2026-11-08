const { ipcRenderer } = require('electron')

const TorrentSummary = require('../lib/torrent-summary')
const sound = require('../lib/sound')
const { dispatch } = require('../lib/dispatcher')

module.exports = class TorrentController {
  constructor (state) {
    this.state = state
  }

  torrentParsed (torrentKey, infoHash, magnetURI) {
    let torrentSummary = this.getTorrentSummary(torrentKey)
    console.log('got infohash for %s torrent %s',
      torrentSummary ? 'existing' : 'new', torrentKey)

    if (!torrentSummary) {
      const torrents = this.state.saved.torrents

      // Check if an existing (non-active) torrent has the same info hash
      if (torrents.find((t) => t.infoHash === infoHash)) {
        ipcRenderer.send('wt-stop-torrenting', infoHash)
        return dispatch('error', 'Cannot add duplicate torrent')
      }

      torrentSummary = {
        torrentKey,
        status: 'new'
      }
      torrents.unshift(torrentSummary)
      sound.play('ADD')
    }

    torrentSummary.infoHash = infoHash
    torrentSummary.magnetURI = magnetURI
    dispatch('update')
  }

  torrentWarning (torrentKey, message) {
    console.log('warning for torrent %s: %s', torrentKey, message)
  }

  torrentError (torrentKey, message) {
    // TODO: WebTorrent needs semantic errors
    if (message.startsWith('Cannot add duplicate torrent')) {
      // Remove infohash from the message
      message = 'Cannot add duplicate torrent'
    }
    dispatch('error', message)

    const torrentSummary = this.getTorrentSummary(torrentKey)
    if (torrentSummary) {
      console.log('Pausing torrent %s due to error: %s', torrentSummary.infoHash, message)
      torrentSummary.status = 'paused'
      dispatch('update')
    }
  }

  torrentMetadata (torrentKey, torrentInfo) {
    // Summarize torrent
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.status = 'downloading'
    torrentSummary.name = torrentSummary.displayName || torrentInfo.name
    torrentSummary.path = torrentInfo.path
    // TODO: make torrentInfo immutable, save separately as torrentSummary.info
    // For now, check whether torrentSummary.files has already been set:
    const hasDetailedFileInfo = torrentSummary.files && torrentSummary.files[0].path
    if (!hasDetailedFileInfo) {
      torrentSummary.files = torrentInfo.files
    }
    if (!torrentSummary.selections) {
      // Nothing is downloaded until the user plays a file
      torrentSummary.selections = torrentSummary.files.map(() => false)
    }
    dispatch('update')

    // Save the .torrent file, if it hasn't been saved already. This is what
    // lets the file list stay browsable while the torrent itself is idle.
    if (!torrentSummary.torrentFileName) {
      ipcRenderer.send('wt-save-torrent-file', torrentKey)
    } else {
      // We already have everything we need to browse this torrent offline, so
      // put it back to sleep rather than leave it connected to peers
      dispatch('idleTorrent', torrentSummary.infoHash)
    }

    // Note: poster images are deliberately not generated. Making one means
    // downloading part of a video or image file, and nothing is downloaded
    // unless the user asks for it by playing it.
  }

  torrentDone (torrentKey, torrentInfo) {
    // "Done" here means the file being previewed has finished buffering, not
    // that a download completed: the data is deleted as soon as playback stops.
    // So don't switch the torrent to seeding and don't congratulate the user.
    const torrentSummary = this.getTorrentSummary(torrentKey)
    if (!torrentSummary) return

    console.log('finished buffering torrent %s', torrentSummary.infoHash)
    dispatch('update')
  }

  torrentProgress (progressInfo) {
    // Overall progress across all active torrents, 0 to 1, or -1 to hide the progress bar
    // Hide progress bar when client has no torrents, or progress is 100%
    const progress = (!progressInfo.hasActiveTorrents || progressInfo.progress === 1)
      ? -1
      : progressInfo.progress

    // Show progress bar under the WebTorrent taskbar icon, on OSX
    this.state.dock.progress = progress

    // Update progress for each individual torrent
    progressInfo.torrents.forEach((p) => {
      const torrentSummary = this.getTorrentSummary(p.torrentKey)
      if (!torrentSummary) {
        console.log('warning: got progress for missing torrent %s', p.torrentKey)
        return
      }
      torrentSummary.progress = p
    })

    // TODO: Find an efficient way to re-enable this line, which allows subtitle
    //       files which are completed after a video starts to play to be added
    //       dynamically to the list of subtitles.
    // checkForSubtitles()
  }

  torrentFileModtimes (torrentKey, fileModtimes) {
    const torrentSummary = this.getTorrentSummary(torrentKey)
    if (!torrentSummary) throw new Error('Not saving modtimes for deleted torrent ' + torrentKey)
    torrentSummary.fileModtimes = fileModtimes
    dispatch('stateSave')
  }

  torrentFileSaved (torrentKey, torrentFileName) {
    console.log('torrent file saved %s: %s', torrentKey, torrentFileName)
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.torrentFileName = torrentFileName
    dispatch('stateSave')

    // The file list is now saved, so the torrent can be browsed without being
    // connected. Stop it unless the user is previewing something from it.
    dispatch('idleTorrent', torrentSummary.infoHash)
  }

  torrentPosterSaved (torrentKey, posterFileName) {
    const torrentSummary = this.getTorrentSummary(torrentKey)
    torrentSummary.posterFileName = posterFileName
    dispatch('stateSave')
  }

  torrentAudioMetadata (infoHash, index, info) {
    const torrentSummary = this.getTorrentSummary(infoHash)
    const fileSummary = torrentSummary.files[index]
    fileSummary.audioInfo = info
    dispatch('update')
  }

  torrentServerRunning (serverInfo) {
    this.state.server = serverInfo
    // The video engine may have been waiting for a URL to play
    dispatch('mpvMaybeLoad')
  }

  // Gets a torrent summary {name, infoHash, status} from state.saved.torrents
  // Returns undefined if we don't know that infoHash
  getTorrentSummary (torrentKey) {
    return TorrentSummary.getByKey(this.state, torrentKey)
  }
}
