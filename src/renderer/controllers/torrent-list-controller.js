const fs = require('fs')
const path = require('path')
const { ipcRenderer, clipboard } = require('electron')
const remote = require('@electron/remote')

const { dispatch } = require('../lib/dispatcher')
const { TorrentKeyNotFoundError } = require('../lib/errors')
const sound = require('../lib/sound')
const TorrentSummary = require('../lib/torrent-summary')
const { showContextMenu } = require('../lib/context-menu')
const FileTree = require('../lib/file-tree')
const PlaybackPosition = require('../lib/playback-position')
const { formatPosition } = require('../lib/time')

const instantIoRegex = /^(https:\/\/)?instant\.io\/#/

// Controls the torrent list: creating, adding, deleting, & manipulating torrents
module.exports = class TorrentListController {
  constructor (state) {
    this.state = state
  }

  // Adds a torrent to the list, starts downloading/seeding.
  // TorrentID can be a magnet URI, infohash, or torrent file: https://git.io/vik9M
  addTorrent (torrentId) {
    if (torrentId.path) {
      // Use path string instead of W3C File object
      torrentId = torrentId.path
    }

    // Trim extra spaces off pasted magnet links
    if (typeof torrentId === 'string') {
      torrentId = torrentId.trim()
    }

    // Allow a instant.io link to be pasted
    if (typeof torrentId === 'string' && instantIoRegex.test(torrentId)) {
      torrentId = torrentId.slice(torrentId.indexOf('#') + 1)
    }

    const torrentKey = this.state.nextTorrentKey++

    // Add it into the temp folder. Adding a torrent only fetches its metadata -
    // no file is selected, so no file data is downloaded - and once the
    // .torrent file is saved the torrent is put back to sleep. The entry itself
    // stays in the list until the user removes it.
    const tempPath = TorrentSummary.getTempPath(
      null, this.state.nextStreamKey++, this.state.tempPath)

    ipcRenderer.send('wt-start-torrenting', torrentKey, torrentId, tempPath)

    dispatch('backToList')
  }

  // A torrent with no selected files has no reason to stay connected: it is just
  // sitting in the list waiting to be browsed. Stop it and clear its scratch
  // folder, keeping the saved file list so it stays browsable.
  idleTorrent (infoHash) {
    const state = this.state
    const torrentSummary = TorrentSummary.getByKey(state, infoHash)
    if (!torrentSummary || !torrentSummary.infoHash) return
    if (torrentSummary.status === 'paused') return

    // Never touch the torrent we're previewing from
    if (state.playing.infoHash === torrentSummary.infoHash) return
    if (state.streaming && state.streaming.infoHash === torrentSummary.infoHash) return

    // Somebody explicitly asked for a file in this torrent
    if (torrentSummary.selections && torrentSummary.selections.some(Boolean)) return

    // A poster frame is being taken from this torrent right now
    if (state.postersInFlight.has(torrentSummary.infoHash)) return

    console.log('idling torrent %s: no files selected', torrentSummary.infoHash)
    torrentSummary.status = 'paused'
    // Nothing has been downloaded yet, so disconnect entirely rather than sit
    // connected to peers. The saved file list keeps the folder tree browsable.
    ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
  }

  // Shows the Create Torrent page with options to seed a given file or folder
  showCreateTorrent (files) {
    // You can only create torrents from the home screen.
    if (this.state.location.url() !== 'home') {
      return dispatch('error', 'Please go back to the torrent list before creating a new torrent.')
    }

    // Files will either be an array of file objects, which we can send directly
    // to the create-torrent screen
    if (files.length === 0 || typeof files[0] !== 'string') {
      this.state.location.go({
        url: 'create-torrent',
        files,
        setup: (cb) => {
          this.state.window.title = 'Create New Torrent'
          cb(null)
        }
      })
      return
    }

    // ... or it will be an array of mixed file and folder paths. We have to walk
    // through all the folders and find the files
    findFilesRecursive(files, (allFiles) => this.showCreateTorrent(allFiles))
  }

  // Creates a new torrent and start seeeding
  createTorrent (options) {
    const state = this.state
    const torrentKey = state.nextTorrentKey++
    ipcRenderer.send('wt-create-torrent', torrentKey, options)
    state.location.cancel()
  }

  // Starts a given torrentSummary. Only the files in s.selections are fetched,
  // which is nothing at all unless the user has pressed play on something.
  startTorrentingSummary (torrentKey) {
    const s = TorrentSummary.getByKey(this.state, torrentKey)
    if (!s) throw new TorrentKeyNotFoundError(torrentKey)

    // Everything streams into a temp folder inside the program's own folder,
    // cleared when the app starts and quits. There is no download folder to
    // check for, so no 'path-missing' check.
    // Resolved fresh each time, so a new temp folder takes effect from the
    // next video played
    s.path = TorrentSummary.getTempPath(s, this.state.nextStreamKey++, this.state.tempPath)
    delete s.error
    delete s.fileModtimes

    // The info hash lets the WebTorrent process notice the torrent is already
    // running and reuse it, instead of starting it from nothing again
    ipcRenderer.send('wt-start-torrenting',
      s.torrentKey,
      TorrentSummary.getTorrentId(s),
      s.path,
      s.infoHash,
      s.selections)
  }

  setGlobalTrackers (globalTrackers) {
    ipcRenderer.send('wt-set-global-trackers', globalTrackers)
  }

  // TODO: use torrentKey, not infoHash
  toggleTorrent (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (torrentSummary.status === 'paused') {
      torrentSummary.status = 'new'
      this.startTorrentingSummary(torrentSummary.torrentKey)
      sound.play('ENABLE')
      return
    }

    this.pauseTorrent(torrentSummary, true)
  }

  pauseAllTorrents () {
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (torrentSummary.status === 'downloading' ||
          torrentSummary.status === 'seeding') {
        torrentSummary.status = 'paused'
        ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)
      }
    })
    sound.play('DISABLE')
  }

  resumeAllTorrents () {
    this.state.saved.torrents.forEach((torrentSummary) => {
      if (torrentSummary.status === 'paused') {
        torrentSummary.status = 'downloading'
        this.startTorrentingSummary(torrentSummary.torrentKey)
      }
    })
    sound.play('ENABLE')
  }

  pauseTorrent (torrentSummary, playSound) {
    torrentSummary.status = 'paused'
    ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)

    if (playSound) sound.play('DISABLE')
  }

  prioritizeTorrent (infoHash) {
    this.state.saved.torrents
      .filter(torrent => ['downloading', 'seeding'].includes(torrent.status)) // Active torrents only.
      .forEach((torrent) => { // Pause all active torrents except the one that started playing.
        if (infoHash === torrent.infoHash) return

        // Pause torrent without playing sounds.
        this.pauseTorrent(torrent, false)

        this.state.saved.torrentsToResume.push(torrent.infoHash)
      })

    console.log('Playback Priority: paused torrents: ', this.state.saved.torrentsToResume)
  }

  resumePausedTorrents () {
    console.log('Playback Priority: resuming paused torrents')
    if (!this.state.saved.torrentsToResume || !this.state.saved.torrentsToResume.length) return
    this.state.saved.torrentsToResume.forEach((infoHash) => {
      this.toggleTorrent(infoHash)
    })

    // reset paused torrents
    this.state.saved.torrentsToResume = []
  }

  toggleTorrentFile (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    torrentSummary.selections[index] = !torrentSummary.selections[index]

    // Let the WebTorrent process know to start or stop fetching that file
    if (torrentSummary.status !== 'paused') {
      ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
    } else if (torrentSummary.selections.some(Boolean)) {
      // The torrent was asleep. Wake it up so the file can actually arrive.
      torrentSummary.status = 'new'
      this.startTorrentingSummary(torrentSummary.torrentKey)
    }
  }

  /**
   * The cloud button on a file: fetch it now, so it is ready to watch later,
   * or stop fetching it if it was already asked for.
   *
   * What has been downloaded is still thrown away when the app quits, like
   * everything else in the temp folder, so this lasts for the session.
   */
  togglePreloadFile (infoHash, index) {
    const state = this.state
    const torrentSummary = TorrentSummary.getByKey(state, infoHash)
    if (!torrentSummary || !torrentSummary.files) return

    const preloads = state.preloads.get(infoHash) || new Set()
    if (preloads.has(index)) preloads.delete(index)
    else preloads.add(index)

    if (preloads.size > 0) state.preloads.set(infoHash, preloads)
    else state.preloads.delete(infoHash)

    this.applySelections(infoHash)
  }

  /**
   * The cloud button on a folder: fetch every video in it, or stop fetching
   * them if they were all asked for already.
   */
  togglePreloadFolder (infoHash, indexes) {
    const state = this.state
    const torrentSummary = TorrentSummary.getByKey(state, infoHash)
    if (!torrentSummary || !torrentSummary.files || indexes.length === 0) return

    const preloads = state.preloads.get(infoHash) || new Set()
    const allChosen = indexes.every(index => preloads.has(index))

    indexes.forEach(index => {
      if (allChosen) preloads.delete(index)
      else preloads.add(index)
    })

    if (preloads.size > 0) state.preloads.set(infoHash, preloads)
    else state.preloads.delete(infoHash)

    this.applySelections(infoHash)
  }

  /**
   * Works out which files of a torrent should be downloading - the one being
   * watched, plus anything preloaded - and tells the WebTorrent process. A
   * torrent nothing is wanted from goes back to sleep.
   */
  applySelections (infoHash) {
    const state = this.state
    const torrentSummary = TorrentSummary.getByKey(state, infoHash)
    if (!torrentSummary || !torrentSummary.files) return

    const preloads = state.preloads.get(infoHash) || new Set()
    const streamingIndex = state.streaming && state.streaming.infoHash === infoHash
      ? state.streaming.fileIndex
      : -1

    torrentSummary.selections = torrentSummary.files.map(
      (file, i) => preloads.has(i) || i === streamingIndex)

    if (torrentSummary.selections.some(Boolean)) {
      if (torrentSummary.status === 'paused') {
        // A sleeping torrent picks the selections up as it starts
        this.startTorrentingSummary(torrentSummary.torrentKey)
      } else {
        ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
      }
      torrentSummary.status = 'downloading'
    } else {
      ipcRenderer.send('wt-select-files', infoHash, torrentSummary.selections)
      dispatch('idleTorrent', infoHash)
    }

    dispatch('stateSave')
    dispatch('update')
  }

  // Right-clicking a file: clear where we got to, or change whether it counts
  // as watched
  openFileContextMenu (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary || !torrentSummary.files) return
    const file = torrentSummary.files[index]
    if (!file) return

    showContextMenu([
      PlaybackPosition.hasProgress(file) && {
        label: `Clear progress (${formatPosition(file.currentTime)})`,
        action: 'clearFileProgress',
        args: [infoHash, index]
      },
      {
        label: PlaybackPosition.isWatched(file) ? 'Mark as unwatched' : 'Mark as watched',
        action: 'toggleFileWatched',
        args: [infoHash, index]
      }
    ])
  }

  clearFileProgress (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary || !torrentSummary.files) return
    PlaybackPosition.clearProgress(torrentSummary.files[index])
    dispatch('stateSaveImmediate')
  }

  toggleFileWatched (infoHash, index) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary || !torrentSummary.files) return
    const file = torrentSummary.files[index]
    if (!file) return

    if (PlaybackPosition.isWatched(file)) {
      PlaybackPosition.clearProgress(file)
      delete file.played
    } else {
      PlaybackPosition.markFinished(file)
    }
    dispatch('stateSaveImmediate')
  }

  // Open or close a folder in a torrent's file tree.
  // Which folders are open lasts as long as the app is running, so coming
  // back from the player shows the list as it was left. It is not written to
  // disk: a torrent opens with its folders closed every time the app starts.
  toggleFolder (infoHash, folderKey) {
    const expanded = this.state.folderExpanded
    const key = FileTree.getFolderKey(infoHash, folderKey)
    if (expanded[key]) delete expanded[key]
    else expanded[key] = true
  }

  // Open or close every folder of one torrent at once
  setAllFoldersExpanded (infoHash, expanded) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary) return

    const open = this.state.folderExpanded
    const sortByName = this.state.saved.prefs.sortByName
    const walk = (node) => {
      node.folders.forEach((folder) => {
        const key = FileTree.getFolderKey(infoHash, folder.key)
        if (expanded) open[key] = true
        else delete open[key]
        walk(folder)
      })
    }
    walk(FileTree.getTree(torrentSummary, sortByName))
  }

  confirmDeleteTorrent (infoHash, deleteData) {
    this.state.modal = {
      id: 'remove-torrent-modal',
      infoHash,
      deleteData
    }
  }

  confirmDeleteAllTorrents (deleteData) {
    this.state.modal = {
      id: 'delete-all-torrents-modal',
      deleteData
    }
  }

  // TODO: use torrentKey, not infoHash
  deleteTorrent (infoHash, deleteData) {
    const index = this.state.saved.torrents.findIndex((x) => x.infoHash === infoHash)

    if (index > -1) {
      const summary = this.state.saved.torrents[index]
      deleteTorrentFile(summary, deleteData)

      // remove torrent from saved list
      this.state.saved.torrents.splice(index, 1)
      dispatch('stateSave')

      // prevent user from going forward to a deleted torrent
      this.state.location.clearForward('player')
      sound.play('DELETE')
    } else {
      throw new TorrentKeyNotFoundError(infoHash)
    }
  }

  deleteAllTorrents (deleteData) {
    // Go back to list before the current playing torrent is deleted
    if (this.state.location.url() === 'player') {
      dispatch('backToList')
    }

    this.state.saved.torrents.forEach((summary) => deleteTorrentFile(summary, deleteData))

    this.state.saved.torrents = []
    dispatch('stateSave')

    // prevent user from going forward to a deleted torrent
    this.state.location.clearForward('player')
    sound.play('DELETE')
  }

  /**
   * Finishes a drag: the torrent being dragged is moved to where it was let
   * go, and the new order is saved.
   */
  dropTorrent () {
    const state = this.state
    const moving = state.draggingTorrent
    const before = state.dropBefore
    const after = state.dropAfter

    state.draggingTorrent = null
    state.dropBefore = null
    state.dropAfter = null

    const target = before || after
    if (!moving || !target || moving === target) return

    const torrents = state.saved.torrents
    const from = torrents.findIndex(t => t.infoHash === moving)
    if (from < 0) return

    const [torrent] = torrents.splice(from, 1)

    let to = torrents.findIndex(t => t.infoHash === target)
    if (to < 0) {
      // The one it was dropped on has gone: put it back where it was
      torrents.splice(from, 0, torrent)
      return
    }
    if (after) to += 1

    torrents.splice(to, 0, torrent)
    dispatch('stateSave')
  }

  toggleSelectTorrent (infoHash) {
    if (this.state.selectedInfoHash === infoHash) {
      this.state.selectedInfoHash = null
    } else {
      this.state.selectedInfoHash = infoHash
    }
  }

  // Right-clicking the list itself: offer whatever is on the clipboard, which
  // is how a magnet link is added with the mouse alone
  openTorrentListContextMenu () {
    const text = clipboard.readText().trim()

    showContextMenu([{
      label: 'Paste',
      enabled: text !== '',
      action: 'addTorrent',
      args: [text]
    }])
  }

  openTorrentContextMenu (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    const sortedByName = this.state.saved.prefs.sortByName

    showContextMenu([
      {
        label: 'Search',
        action: 'findInTorrent',
        args: [torrentSummary.infoHash]
      },
      { type: 'separator' },
      {
        label: 'Remove From List',
        action: 'confirmDeleteTorrent',
        args: [torrentSummary.infoHash, false]
      },
      {
        label: 'Remove Data File',
        action: 'confirmDeleteTorrent',
        args: [torrentSummary.infoHash, true]
      },
      { type: 'separator' },
      torrentSummary.files && {
        label: process.platform === 'darwin' ? 'Show in Finder' : 'Show in Folder',
        action: 'showTorrentInFolder',
        args: [torrentSummary.infoHash]
      },
      torrentSummary.files && { type: 'separator' },
      {
        label: 'Copy Magnet Link to Clipboard',
        action: 'copyToClipboard',
        args: [torrentSummary.magnetURI]
      },
      {
        label: 'Copy Instant.io Link to Clipboard',
        action: 'copyToClipboard',
        args: [`https://instant.io/#${torrentSummary.infoHash}`]
      },
      {
        label: 'Save Torrent File As...',
        enabled: torrentSummary.torrentFileName != null,
        action: 'saveTorrentFileAs',
        args: [torrentSummary.torrentKey]
      },
      { type: 'separator' },
      torrentSummary.files && {
        label: 'Expand All Folders',
        action: 'setAllFoldersExpanded',
        args: [torrentSummary.infoHash, true]
      },
      torrentSummary.files && {
        label: 'Collapse All Folders',
        action: 'setAllFoldersExpanded',
        args: [torrentSummary.infoHash, false]
      },
      torrentSummary.files && { type: 'separator' },
      {
        label: `${sortedByName ? '✓ ' : ''}Sort by Name`,
        action: 'updatePreferences',
        args: ['sortByName', !sortedByName]
      }
    ])
  }

  // Opens the folder the torrent's files are in
  showTorrentInFolder (infoHash) {
    const torrentSummary = TorrentSummary.getByKey(this.state, infoHash)
    if (!torrentSummary) return
    showItemInFolder(torrentSummary)
  }

  // Takes a torrentSummary or torrentKey
  // Shows a Save File dialog, then saves the .torrent file wherever the user requests
  saveTorrentFileAs (torrentKey) {
    const torrentSummary = TorrentSummary.getByKey(this.state, torrentKey)
    if (!torrentSummary) throw new TorrentKeyNotFoundError(torrentKey)
    const downloadPath = this.state.saved.prefs.downloadPath
    const newFileName = path.parse(torrentSummary.name).name + '.torrent'
    const win = remote.getCurrentWindow()
    const opts = {
      title: 'Save Torrent File',
      defaultPath: path.join(downloadPath, newFileName),
      filters: [
        { name: 'Torrent Files', extensions: ['torrent'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      buttonLabel: 'Save'
    }

    const savePath = remote.dialog.showSaveDialogSync(win, opts)

    if (!savePath) return // They clicked Cancel
    console.log('Saving torrent ' + torrentKey + ' to ' + savePath)
    const torrentPath = TorrentSummary.getTorrentPath(torrentSummary)
    fs.readFile(torrentPath, (err, torrentFile) => {
      if (err) return dispatch('error', err)
      fs.writeFile(savePath, torrentFile, err => {
        if (err) return dispatch('error', err)
      })
    })
  }
}

// Recursively finds {name, path, size} for all files in a folder
// Calls `cb` on success, calls `onError` on failure
function findFilesRecursive (paths, cb_) {
  if (paths.length > 1) {
    let numComplete = 0
    const ret = []
    paths.forEach(path => {
      findFilesRecursive([path], fileObjs => {
        ret.push(...fileObjs)
        if (++numComplete === paths.length) {
          ret.sort((a, b) => a.path < b.path ? -1 : Number(a.path > b.path))
          cb_(ret)
        }
      })
    })
    return
  }

  const fileOrFolder = paths[0]
  fs.stat(fileOrFolder, (err, stat) => {
    if (err) return dispatch('error', err)

    // Files: return name, path, and size
    if (!stat.isDirectory()) {
      const filePath = fileOrFolder
      return cb_([{
        name: path.basename(filePath),
        path: filePath,
        size: stat.size
      }])
    }

    // Folders: recurse, make a list of all the files
    const folderPath = fileOrFolder
    fs.readdir(folderPath, (err, fileNames) => {
      if (err) return dispatch('error', err)
      const paths = fileNames.map((fileName) => path.join(folderPath, fileName))
      findFilesRecursive(paths, cb_)
    })
  })
}

function deleteFile (path) {
  if (!path) return
  fs.unlink(path, err => {
    if (err) dispatch('error', err)
  })
}

// Delete all files in a torrent
function moveItemToTrash (torrentSummary) {
  const filePath = TorrentSummary.getFileOrFolder(torrentSummary)
  if (filePath) ipcRenderer.send('moveItemToTrash', filePath)
}

function showItemInFolder (torrentSummary) {
  ipcRenderer.send('showItemInFolder', TorrentSummary.getFileOrFolder(torrentSummary))
}

function deleteTorrentFile (torrentSummary, deleteData) {
  // The user removed this torrent from the list, so its temp files go too:
  // anything in there is a preview, and the entry is not coming back.
  ipcRenderer.send('wt-delete-torrent-data', torrentSummary.infoHash)
  ipcRenderer.send('wt-stop-torrenting', torrentSummary.infoHash)

  // remove torrent and poster file
  deleteFile(TorrentSummary.getTorrentPath(torrentSummary))
  deleteFile(TorrentSummary.getPosterPath(torrentSummary))

  // optionally delete the torrent data
  if (deleteData) moveItemToTrash(torrentSummary)
}
