const React = require('react')
const prettyBytes = require('prettier-bytes')

const LinearProgress = require('material-ui/LinearProgress').default

const TorrentSummary = require('../lib/torrent-summary')
const TorrentPlayer = require('../lib/torrent-player')
const FileTree = require('../lib/file-tree')
const PlaybackPosition = require('../lib/playback-position')
const { dispatch, dispatcher } = require('../lib/dispatcher')
const { calculateEta, formatPosition } = require('../lib/time')

module.exports = class TorrentList extends React.Component {
  // The list scrolls inside .content, which is owned by the app shell. Watch it
  // so we always know where the user was, and put them back there when they
  // come back from the player instead of jumping to the top.
  componentDidMount () {
    this.scrollElem = document.querySelector('.content')
    if (!this.scrollElem) return

    this.handleScroll = () => {
      this.props.state.listScrollTop = this.scrollElem.scrollTop
    }
    this.scrollElem.addEventListener('scroll', this.handleScroll)

    const top = this.props.state.listScrollTop
    if (!top) return
    this.scrollElem.scrollTop = top
    // ...and again once the browser has laid the rows out
    window.requestAnimationFrame(() => {
      if (this.scrollElem) this.scrollElem.scrollTop = top
    })
  }

  componentWillUnmount () {
    if (this.scrollElem && this.handleScroll) {
      this.scrollElem.removeEventListener('scroll', this.handleScroll)
    }
    this.scrollElem = null
  }

  render () {
    const state = this.props.state

    const contents = []
    const continueWatching = this.renderContinueWatching()
    if (continueWatching) contents.push(continueWatching)

    const torrentElems = state.saved.torrents.map(
      (torrentSummary) => this.renderTorrent(torrentSummary)
    )
    contents.push(...torrentElems)
    contents.push(
      <div key='torrent-placeholder' className='torrent-placeholder'>
        <span className='ellipsis'>Drop a torrent file here or paste a magnet link</span>
      </div>
    )

    return (
      <div
        key='torrent-list'
        className='torrent-list'
        onContextMenu={dispatcher('openTorrentListContextMenu')}
      >
        {contents}
      </div>
    )
  }

  renderTorrent (torrentSummary) {
    const state = this.props.state
    const infoHash = torrentSummary.infoHash
    const isSelected = infoHash && state.selectedInfoHash === infoHash

    // Background image: show some nice visuals, like a frame from the movie, if possible
    const style = {}
    if (torrentSummary.posterFileName) {
      const gradient = 'linear-gradient(to bottom, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0.4) 100%)'
      const posterPath = TorrentSummary.getPosterPath(torrentSummary)
      style.backgroundImage = `${gradient}, url('${posterPath}')`
    }

    // Foreground: name of the torrent, basic info like size, play button,
    // cast buttons if available, and delete
    const classes = ['torrent']
    if (isSelected) classes.push('selected')
    if (!infoHash) classes.push('disabled')
    if (!torrentSummary.torrentKey) throw new Error('Missing torrentKey')
    return (
      <div
        id={torrentSummary.testID && ('torrent-' + torrentSummary.testID)}
        key={torrentSummary.torrentKey}
        style={style}
        className={classes.join(' ')}
        onContextMenu={infoHash && dispatcher('openTorrentContextMenu', infoHash)}
        onClick={infoHash && dispatcher('toggleSelectTorrent', infoHash)}
      >
        {this.renderTorrentMetadata(torrentSummary)}
        {infoHash ? this.renderTorrentButtons(torrentSummary) : null}
        {isSelected ? this.renderTorrentDetails(torrentSummary) : null}
        <hr />
      </div>
    )
  }

  // Show name, download status, % complete
  renderTorrentMetadata (torrentSummary) {
    const name = torrentSummary.name || 'Loading torrent...'
    const elements = [(
      <div key='name' className='name ellipsis'>{name}</div>
    )]

    // If it's downloading/seeding then show progress info
    const prog = torrentSummary.progress

    // A torrent is woken up when it is added, to read its file list, and again
    // briefly to take a thumbnail from it. Neither is the user downloading
    // anything, so say what is really going on instead of showing a download
    // that is not happening, and show the peers it has found either way.
    const makingPoster = this.props.state.postersInFlight
      .has(torrentSummary.infoHash)
    const hasFileList = !!(torrentSummary.files && torrentSummary.files.length)

    let progElems
    if (torrentSummary.error) {
      progElems = [getErrorMessage(torrentSummary)]
    } else if (torrentSummary.status === 'paused' || !prog) {
      progElems = [renderTorrentStatus()]
    } else if (makingPoster || !hasFileList) {
      progElems = [
        <span key='torrent-status'>{renderWaitingFor()}</span>,
        renderPeers()
      ]
    } else {
      progElems = [
        renderTorrentStatus(),
        renderProgressBar(),
        renderPercentProgress(),
        renderTotalProgress(),
        renderPeers(),
        renderSpeeds(),
        renderEta()
      ]
    }
    elements.push(
      <div key='progress-info' className='ellipsis'>
        {progElems}
      </div>
    )

    return (<div key='metadata' className='metadata'>{elements}</div>)

    // What a torrent that is awake but not downloading for the user is up to
    function renderWaitingFor () {
      if (makingPoster) return 'Making a thumbnail'
      if (!prog.numPeers) return 'Connecting to peers'
      return 'Getting the file list'
    }

    function renderProgressBar () {
      const progress = Math.floor(100 * prog.progress)
      const styles = {
        wrapper: {
          display: 'inline-block',
          marginRight: 8
        },
        progress: {
          height: 8,
          width: 30
        }
      }
      return (
        <div key='progress-bar' style={styles.wrapper}>
          <LinearProgress style={styles.progress} mode='determinate' value={progress} />
        </div>
      )
    }

    function renderPercentProgress () {
      const progress = Math.floor(100 * prog.progress)
      return (<span key='percent-progress'>{progress}%</span>)
    }

    function renderTotalProgress () {
      const downloaded = prettyBytes(prog.downloaded)
      const total = prettyBytes(prog.length || 0)
      if (downloaded === total) {
        return (<span key='total-progress'>{downloaded}</span>)
      } else {
        return (<span key='total-progress'>{downloaded} / {total}</span>)
      }
    }

    function renderPeers () {
      if (prog.numPeers === 0) return
      const count = prog.numPeers === 1 ? 'peer' : 'peers'
      return (<span key='peers'>{prog.numPeers} {count}</span>)
    }

    function renderSpeeds () {
      let str = ''
      if (prog.downloadSpeed > 0) str += ' ↓ ' + prettyBytes(prog.downloadSpeed) + '/s'
      if (prog.uploadSpeed > 0) str += ' ↑ ' + prettyBytes(prog.uploadSpeed) + '/s'
      if (str === '') return
      return (<span key='download'>{str}</span>)
    }

    function renderEta () {
      const downloaded = prog.downloaded
      const total = prog.length || 0
      const missing = total - downloaded
      const downloadSpeed = prog.downloadSpeed
      if (downloadSpeed === 0 || missing === 0) return

      const etaStr = calculateEta(missing, downloadSpeed)

      return (<span key='eta'>{etaStr}</span>)
    }

    function renderTorrentStatus () {
      let status
      if (torrentSummary.status === 'paused') {
        // A torrent nothing is being played from is simply idle. There is no
        // longer a button to start or stop one, so there is nothing for a
        // "Paused" label to mean.
        status = ''
      } else if (torrentSummary.status === 'downloading') {
        if (!torrentSummary.progress) status = ''
        else if (!torrentSummary.progress.ready) status = 'Verifying'
        else status = 'Downloading'
      } else if (torrentSummary.status === 'seeding') {
        status = 'Seeding'
      } else { // torrentSummary.status is 'new' or something unexpected
        status = ''
      }
      return (<span key='torrent-status'>{status}</span>)
    }
  }

  // Download button toggles between torrenting (DL/seed) and paused
  // Play button starts streaming the torrent immediately, unpausing if needed
  renderTorrentButtons (torrentSummary) {
    const infoHash = torrentSummary.infoHash

    // Only show the play/dowload buttons for torrents that contain playable media
    let playButton
    if (!torrentSummary.error && TorrentPlayer.isPlayableTorrentSummary(torrentSummary)) {
      playButton = (
        <i
          key='play-button'
          title='Start streaming'
          className='icon play'
          onClick={dispatcher('playFile', infoHash)}
        >
          play_circle_outline
        </i>
      )
    }

    return (
      <div className='torrent-controls'>
        {playButton}
        <i
          key='delete-button'
          className='icon delete'
          title='Remove torrent'
          onClick={dispatcher('confirmDeleteTorrent', infoHash, false)}
        >
          close
        </i>
      </div>
    )
  }

  // Show files grouped into folders, with per-file status and play buttons.
  // Only open folders are rendered, so a torrent with thousands of files costs
  // no more to draw than a torrent with ten.
  renderTorrentDetails (torrentSummary) {
    let filesElement
    if (torrentSummary.error || !torrentSummary.files) {
      let message = ''
      if (torrentSummary.error === 'path-missing') {
        // Special case error: this torrent's download dir or file is missing
        message = 'Missing path: ' + TorrentSummary.getFileOrFolder(torrentSummary)
      } else if (torrentSummary.error) {
        // General error for this torrent: just show the message
        message = torrentSummary.error.message || torrentSummary.error
      } else if (torrentSummary.status === 'paused') {
        // No file info, no infohash, and we're not trying to download from the DHT
        message = 'Failed to load torrent info. Click the download button to try again...'
      } else {
        // No file info, no infohash, trying to load from the DHT
        message = 'Downloading torrent info...'
      }
      filesElement = (
        <div key='files' className='files warning'>
          {message}
        </div>
      )
    } else {
      // We do know the files. Lay them out as a folder tree.
      const sortByName = this.props.state.saved.prefs.sortByName
      const tree = FileTree.getTree(torrentSummary, sortByName)
      const rows = this.renderTreeRows(torrentSummary, tree, 0, [])

      filesElement = (
        <div key='files' className='files'>
          <table>
            <tbody>
              {rows}
            </tbody>
          </table>
        </div>
      )
    }

    return (
      <div key='details' className='torrent-details'>
        {filesElement}
      </div>
    )
  }

  // Walks the folder tree and collects the rows that are currently visible:
  // a folder's contents only show up once that folder has been opened
  renderTreeRows (torrentSummary, node, depth, rows) {
    const state = this.props.state
    const infoHash = torrentSummary.infoHash

    const expanded = state.saved.folderExpanded || {}
    node.folders.forEach((folder) => {
      const isExpanded = !!expanded[FileTree.getFolderKey(infoHash, folder.key)]
      rows.push(this.renderFolderRow(torrentSummary, folder, depth, isExpanded))
      if (isExpanded) this.renderTreeRows(torrentSummary, folder, depth + 1, rows)
    })

    node.files.forEach((entry) => {
      rows.push(this.renderFileRow(torrentSummary, entry.file, entry.index, depth))
    })

    return rows
  }

  // A collapsible folder, like a row in a file explorer. Collapsed by default.
  renderFolderRow (torrentSummary, node, depth, isExpanded) {
    const infoHash = torrentSummary.infoHash
    const fileCount = node.fileCount

    return (
      <tr
        key={'folder-' + node.key}
        className={'folder-row' + (isExpanded ? ' expanded' : '')}
        onClick={dispatcher('toggleFolder', infoHash, node.key)}
      >
        <td className='col-icon' />
        <td className='col-name' style={{ paddingLeft: indentFor(depth) }}>
          <i className='icon chevron'>{isExpanded ? 'expand_more' : 'chevron_right'}</i>
          <i className='icon folder'>{isExpanded ? 'folder_open' : 'folder'}</i>
          <span className='folder-name'>{node.name}</span>
        </td>
        <td className='col-progress' />
        <td className='col-size'>{fileCount === 1 ? '1 file' : fileCount + ' files'}</td>
        <td className='col-select' />
      </tr>
    )
  }

  // Show a single torrentSummary file in the details view for a single torrent
  renderFileRow (torrentSummary, file, index, depth) {
    const state = this.props.state
    const infoHash = torrentSummary.infoHash

    // How much of the file do we have? This is only ever non-zero for the file
    // being previewed right now: its data is deleted as soon as we're done.
    let isDone = false
    let progress = ''
    const fileProg = torrentSummary.progress &&
      torrentSummary.progress.files &&
      torrentSummary.progress.files[index]
    if (fileProg && fileProg.numPieces > 0) {
      isDone = fileProg.numPiecesPresent === fileProg.numPieces
      progress = Math.floor(100 * fileProg.numPiecesPresent / fileProg.numPieces) + '%'
    }

    // Is this the file we're downloading right now, and is it the one that was
    // played last? The second is how the list shows where the user left off.
    const isStreaming = !!state.streaming &&
      state.streaming.infoHash === infoHash &&
      state.streaming.fileIndex === index
    const isLastPlayed = !!state.lastPlayed &&
      state.lastPlayed.infoHash === infoHash &&
      state.lastPlayed.fileIndex === index

    // Did the user ask for this file ahead of watching it?
    const preloads = state.preloads.get(infoHash)
    const isPreloading = !!preloads && preloads.has(index)

    // Where the user got to in this video last time
    const hasPosition = PlaybackPosition.hasProgress(file) && !PlaybackPosition.isFinished(file)
    const watched = PlaybackPosition.isWatched(file)

    let positionElem
    if (hasPosition) {
      // Radial progress bar. 0% = start from 0:00, 270% = 3/4 of the way thru
      positionElem = this.renderRadialProgressBar(PlaybackPosition.getFraction(file))
    }

    const isPlayable = TorrentPlayer.isPlayable(file)
    const isImage = TorrentPlayer.isImage(file)

    let icon
    let handleClick
    if (isPlayable) {
      // Playable? Clicking it downloads just this file and shows it
      icon = isImage ? 'image' : 'play_arrow'
      handleClick = dispatcher('playFile', infoHash, index)
    } else {
      icon = 'description' /* file icon, opens in OS default app */
      handleClick = isDone
        ? dispatcher('openPath', infoHash, index)
        : (e) => e.stopPropagation() // noop if file is not ready
    }

    // A file we can't show and don't have can't be opened at all
    const rowClass = (!isPlayable && !isDone) ? 'disabled' : ''

    const classes = ['file-row']
    if (isStreaming) classes.push('streaming')
    if (isLastPlayed) classes.push('last-played')
    if (file.played) classes.push('played')
    if (hasPosition) classes.push('in-progress')

    return (
      <tr
        key={'file-' + index}
        className={classes.join(' ')}
        onClick={handleClick}
        onContextMenu={dispatcher('openFileContextMenu', infoHash, index)}
      >
        <td className={'col-icon ' + rowClass}>
          {positionElem}
          <i className='icon'>{icon}</i>
        </td>
        <td className={'col-name ' + rowClass} style={{ paddingLeft: indentFor(depth) }}>
          <div className='file-name ellipsis'>{file.name}</div>
          {hasPosition ? this.renderWatchProgress(file) : null}
        </td>
        <td className={'col-progress ' + rowClass}>
          {isStreaming || isPreloading ? progress : ''}
        </td>
        <td className={'col-size ' + rowClass}>
          {prettyBytes(file.length)}
        </td>
        <td className='col-preload'>
          {isPlayable
            ? this.renderPreloadButton(infoHash, index, isPreloading, isDone, progress)
            : null}
        </td>
        <td className='col-select'>
          {watched
            ? (<i className='icon played-check' title='You have watched this'>check</i>)
            : null}
        </td>
      </tr>
    )
  }

  /**
   * The cloud button on a file row: fetch this video now, so it is ready to
   * watch later, without opening the player. Clicking it again stops.
   */
  renderPreloadButton (infoHash, index, isPreloading, isDone, progress) {
    const done = isPreloading && isDone

    let title
    if (done) title = 'Downloaded, ready to play'
    else if (isPreloading) title = 'Downloading ' + progress + ', click to stop'
    else title = 'Download this file now, without playing it'

    const classes = ['icon', 'preload']
    if (isPreloading) classes.push('active')
    if (done) classes.push('done')

    return (
      <i
        className={classes.join(' ')}
        title={title}
        role='button'
        aria-label={title}
        onClick={(e) => {
          e.stopPropagation()
          dispatch('togglePreloadFile', infoHash, index)
        }}
      >
        {done ? 'cloud_done' : 'cloud_download'}
      </i>
    )
  }

  // "12:34 / 45:00" with a thin bar, under a video the user started but has
  // not finished
  renderWatchProgress (file) {
    const fraction = PlaybackPosition.getFraction(file)
    return (
      <div key='watch-progress' className='watch-progress'>
        <div className='watch-bar'>
          <div className='watch-bar-fill' style={{ width: (fraction * 100) + '%' }} />
        </div>
        <span className='watch-time'>
          {formatPosition(file.currentTime)} / {formatPosition(file.duration)}
        </span>
      </div>
    )
  }

  /**
   * "Continue watching": the videos stopped partway through, most recent first,
   * so they can be picked straight back up.
   */
  renderContinueWatching () {
    const state = this.props.state
    const entries = PlaybackPosition.getContinueWatching(state)
    if (entries.length === 0) return null

    const items = entries.map(({ torrentSummary, file, index }) => {
      const fraction = PlaybackPosition.getFraction(file)
      return (
        <div
          key={torrentSummary.infoHash + ':' + index}
          className='continue-item'
          title={torrentSummary.name + ' — ' + file.name}
          onClick={dispatcher('playFile', torrentSummary.infoHash, index)}
          onContextMenu={dispatcher('openFileContextMenu', torrentSummary.infoHash, index)}
          role='button'
        >
          <div className='continue-name ellipsis'>{file.name}</div>
          <div className='continue-torrent ellipsis'>{torrentSummary.name}</div>
          <div className='watch-bar'>
            <div className='watch-bar-fill' style={{ width: (fraction * 100) + '%' }} />
          </div>
          <div className='continue-time'>
            {formatPosition(file.currentTime)} / {formatPosition(file.duration)}
          </div>
        </div>
      )
    })

    return (
      <div key='continue-watching' className='continue-watching'>
        <div className='continue-heading'>Continue watching</div>
        <div className='continue-row'>{items}</div>
      </div>
    )
  }

  renderRadialProgressBar (fraction, cssClass) {
    const rotation = 360 * fraction
    const transformFill = { transform: 'rotate(' + (rotation / 2) + 'deg)' }
    const transformFix = { transform: 'rotate(' + rotation + 'deg)' }

    return (
      <div key='radial-progress' className={'radial-progress ' + cssClass}>
        <div className='circle'>
          <div className='mask full' style={transformFill}>
            <div className='fill' style={transformFill} />
          </div>
          <div className='mask half'>
            <div className='fill' style={transformFill} />
            <div className='fill fix' style={transformFix} />
          </div>
        </div>
        <div className='inset' />
      </div>
    )
  }
}

// How far a row at this depth in the folder tree is indented, in pixels
function indentFor (depth) {
  return depth * 18
}

function getErrorMessage (torrentSummary) {
  const err = torrentSummary.error
  if (err === 'path-missing') {
    return (
      <span key='path-missing'>
        Path missing.<br />
        Fix and restart the app, or delete the torrent.
      </span>
    )
  }
  return 'Error'
}
