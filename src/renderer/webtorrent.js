// To keep the UI snappy, we run WebTorrent in its own hidden window, a separate
// process from the main window.
console.time('init')

const crypto = require('crypto')
const util = require('util')
const { ipcRenderer } = require('electron')
const fs = require('fs')
const mm = require('music-metadata')
const networkAddress = require('network-address')
const path = require('path')
const WebTorrent = require('webtorrent')

const config = require('../config')
const tempPathLib = require('../temp-path')
const { TorrentKeyNotFoundError } = require('./lib/errors')
const torrentPoster = require('./lib/torrent-poster')

/**
 * WebTorrent version.
 */
const VERSION = require('../../package.json').version

/**
 * Version number in Azureus-style. Generated from major and minor semver version.
 * For example:
 *   '0.16.1' -> '0016'
 *   '1.2.5' -> '0102'
 */
const VERSION_STR = VERSION
  .replace(/\d*./g, v => `0${v % 100}`.slice(-2))
  .slice(0, 4)

/**
 * Version prefix string (used in peer ID). WebTorrent uses the Azureus-style
 * encoding: '-', two characters for client id ('WW'), four ascii digits for version
 * number, '-', followed by random numbers.
 * For example:
 *   '-WW0102-'...
 */
const VERSION_PREFIX = '-WD' + VERSION_STR + '-'

/**
 * Generate an ephemeral peer ID each time.
 */
const PEER_ID = Buffer.from(VERSION_PREFIX + crypto.randomBytes(9).toString('base64'))

// Connect to the WebTorrent and BitTorrent networks. WebTorrent Desktop is a hybrid
// client, as explained here: https://webtorrent.io/faq
let client = window.client = new WebTorrent({ peerId: PEER_ID })

// WebTorrent-to-HTTP streaming sever
let server = null

// Used for diffing, so we only send progress updates when necessary
let prevProgress = null

// Which files the user has actually asked for, per torrent (infoHash -> Set of
// file indexes). Nothing is downloaded unless it is in here, so an empty set
// means the torrent is sitting idle with no data on disk.
const selectedFiles = new Map()

// Where temporary files live. The main window works this out from the saved
// preferences and tells us, so a folder chosen in Preferences is respected
// here too. Folders used before the setting was changed are cleared as well.
let tempRoot = config.TEMP_PATH
let staleTempRoots = []

function setTempPaths (dir, stale) {
  if (dir) tempRoot = dir
  staleTempRoots = Array.isArray(stale) ? stale.filter(p => p && p !== tempRoot) : []
  console.log('temporary files go in %s', tempRoot)
}

init()

function init () {
  listenToClientEvents()

  ipcRenderer.on('wt-set-global-trackers', (e, globalTrackers) =>
    setGlobalTrackers(globalTrackers))
  ipcRenderer.on('wt-start-torrenting', (e, torrentKey, torrentID, path, infoHash, selections) =>
    startTorrenting(torrentKey, torrentID, path, infoHash, selections))
  ipcRenderer.on('wt-stop-torrenting', (e, infoHash) =>
    stopTorrenting(infoHash))
  ipcRenderer.on('wt-create-torrent', (e, torrentKey, options) =>
    createTorrent(torrentKey, options))
  ipcRenderer.on('wt-save-torrent-file', (e, torrentKey) =>
    saveTorrentFile(torrentKey))
  ipcRenderer.on('wt-generate-torrent-poster', (e, torrentKey) =>
    generateTorrentPoster(torrentKey))
  ipcRenderer.on('wt-get-audio-metadata', (e, infoHash, index) =>
    getAudioMetadata(infoHash, index))
  ipcRenderer.on('wt-start-server', (e, infoHash) =>
    startServer(infoHash))
  ipcRenderer.on('wt-stop-server', () =>
    stopServer())
  ipcRenderer.on('wt-select-files', (e, infoHash, selections) =>
    selectFiles(infoHash, selections))
  ipcRenderer.on('wt-stop-downloading', (e, infoHash) =>
    stopDownloading(infoHash))
  ipcRenderer.on('wt-prioritize-position', (e, infoHash, index, seconds, duration) =>
    prioritizePosition(infoHash, index, seconds, duration))
  ipcRenderer.on('wt-fetch-file', (e, infoHash, index) =>
    fetchFile(infoHash, index))
  ipcRenderer.on('wt-delete-torrent-data', (e, infoHash) =>
    deleteTorrentData(infoHash))
  ipcRenderer.on('wt-set-temp-path', (e, dir, stale) =>
    setTempPaths(dir, stale))
  ipcRenderer.on('wt-wipe-temp', () =>
    wipeTemp())
  ipcRenderer.on('wt-clear-temp', () =>
    wipeTemp())
  // Sent by the main process as the app quits: close every file handle and
  // clear the temp folder, then say so, so the app can finish quitting
  ipcRenderer.on('wt-destroy-all', () =>
    wipeTemp(() => ipcRenderer.send('wt-destroyed-all')))

  ipcRenderer.send('ipcReadyWebTorrent')

  window.addEventListener('error', (e) =>
    ipcRenderer.send('wt-uncaught-error', { message: e.error.message, stack: e.error.stack }),
  true)

  setInterval(updateTorrentProgress, 1000)
  console.timeEnd('init')
}

function listenToClientEvents () {
  client.on('warning', (err) => ipcRenderer.send('wt-warning', null, err.message))
  client.on('error', (err) => ipcRenderer.send('wt-error', null, err.message))
}

// Sets the default trackers
function setGlobalTrackers (globalTrackers) {
  globalThis.WEBTORRENT_ANNOUNCE = globalTrackers
}

// Starts a given TorrentID, which can be an infohash, magnet URI, etc.
// Returns a WebTorrent object. See https://git.io/vik9M
function startTorrenting (torrentKey, torrentID, path, infoHash, selections) {
  // Already running? Then its data is still in the temp folder, so just point
  // it at the file we want now. This is what makes replaying a file we already
  // downloaded instant.
  const running = infoHash && client.get(infoHash)
  if (running) {
    console.log('torrent %s is already running, reusing it', infoHash)
    running.key = torrentKey
    if (running.ready) {
      selectFiles(running, selections)
      const info = getTorrentInfo(running)
      ipcRenderer.send('wt-ready', torrentKey, info)
      ipcRenderer.send('wt-ready-' + running.infoHash, torrentKey, info)
    } else {
      running.once('ready', () => selectFiles(running, selections))
    }
    return
  }

  console.log('starting torrent %s: %s', torrentKey, torrentID)

  const torrent = client.add(torrentID, { path })
  torrent.key = torrentKey

  // Listen for ready event, progress notifications, etc
  addTorrentEvents(torrent)

  // WebTorrent selects the whole torrent as soon as it has the metadata. Undo
  // that immediately, before the torrent is ready and starts asking peers for
  // pieces, so that adding a torrent never downloads anything by itself.
  torrent.once('metadata', () => {
    if (torrent.pieces && torrent.pieces.length > 0) {
      torrent.deselect(0, torrent.pieces.length - 1, false)
    }
  })

  // Only download the files the user wants, which by default is none of them
  torrent.once('ready', () => selectFiles(torrent, selections))
}

function stopTorrenting (infoHash) {
  console.log('--- STOP TORRENTING: ', infoHash)
  selectedFiles.delete(infoHash)
  const torrent = client.get(infoHash)
  if (torrent) torrent.destroy()
}

// Create a new torrent, start seeding
function createTorrent (torrentKey, options) {
  console.log('creating torrent', torrentKey, options)
  const paths = options.files.map((f) => f.path)
  const torrent = client.seed(paths, options)
  torrent.key = torrentKey
  addTorrentEvents(torrent)
  ipcRenderer.send('wt-new-torrent')
}

function addTorrentEvents (torrent) {
  torrent.on('warning', (err) =>
    ipcRenderer.send('wt-warning', torrent.key, err.message))
  torrent.on('error', (err) =>
    ipcRenderer.send('wt-error', torrent.key, err.message))
  torrent.on('infoHash', () =>
    ipcRenderer.send('wt-parsed', torrent.key, torrent.infoHash, torrent.magnetURI))
  torrent.on('metadata', torrentMetadata)
  torrent.on('ready', torrentReady)
  torrent.on('done', torrentDone)

  function torrentMetadata () {
    const info = getTorrentInfo(torrent)
    ipcRenderer.send('wt-metadata', torrent.key, info)

    updateTorrentProgress()
  }

  function torrentReady () {
    const info = getTorrentInfo(torrent)
    ipcRenderer.send('wt-ready', torrent.key, info)
    ipcRenderer.send('wt-ready-' + torrent.infoHash, torrent.key, info)

    updateTorrentProgress()
  }

  function torrentDone () {
    // WebTorrent considers a torrent "done" as soon as every selection is
    // satisfied, and with nothing selected that is true from the start. Ignore
    // those: an idle torrent has not finished anything.
    const selected = selectedFiles.get(torrent.infoHash)
    if (!selected || selected.size === 0) return

    const info = getTorrentInfo(torrent)
    ipcRenderer.send('wt-done', torrent.key, info)

    updateTorrentProgress()

    // No file modtimes are recorded: previewed data is deleted as soon as
    // playback stops, so there is never anything on disk to re-verify, and
    // stat'ing every file of a 1000+ file torrent for nothing is expensive.
  }
}

// Produces a JSON saveable summary of a torrent
function getTorrentInfo (torrent) {
  return {
    infoHash: torrent.infoHash,
    magnetURI: torrent.magnetURI,
    name: torrent.name,
    path: torrent.path,
    files: torrent.files.map(getTorrentFileInfo),
    bytesReceived: torrent.received
  }
}

// Produces a JSON saveable summary of a file in a torrent
function getTorrentFileInfo (file) {
  return {
    name: file.name,
    length: file.length,
    path: file.path
  }
}

// Every time we resolve a magnet URI, save the torrent file so that we can use
// it on next startup. Starting with the full torrent metadata will be faster
// than re-fetching it from peers using ut_metadata.
function saveTorrentFile (torrentKey) {
  const torrent = getTorrent(torrentKey)
  const torrentPath = path.join(config.TORRENT_PATH, torrent.infoHash + '.torrent')

  fs.access(torrentPath, fs.constants.R_OK, err => {
    const fileName = torrent.infoHash + '.torrent'
    if (!err) {
      // We've already saved the file
      return ipcRenderer.send('wt-file-saved', torrentKey, fileName)
    }

    // Otherwise, save the .torrent file, under the app config folder
    fs.mkdir(config.TORRENT_PATH, { recursive: true }, _ => {
      fs.writeFile(torrentPath, torrent.torrentFile, err => {
        if (err) return console.log('error saving torrent file %s: %o', torrentPath, err)
        console.log('saved torrent file %s', torrentPath)
        return ipcRenderer.send('wt-file-saved', torrentKey, fileName)
      })
    })
  })
}

// Save a JPG that represents a torrent.
// Auto chooses either a frame from a video file, an image, etc
function generateTorrentPoster (torrentKey) {
  const torrent = getTorrent(torrentKey)

  // The main window keeps the torrent awake until it hears back, so it is
  // told either way, with no file name when there is no poster to show
  const failed = (message, err) => {
    console.log(message, err)
    ipcRenderer.send('wt-poster', torrentKey, null)
  }

  torrentPoster(torrent, (err, buf, extension) => {
    if (err) return failed('error generating poster: %o', err)
    // save it for next time
    fs.mkdir(config.POSTER_PATH, { recursive: true }, err => {
      if (err) return failed('error creating poster dir: %o', err)
      const posterFileName = torrent.infoHash + extension
      const posterFilePath = path.join(config.POSTER_PATH, posterFileName)
      fs.writeFile(posterFilePath, buf, err => {
        if (err) return failed('error saving poster: %o', err)
        // show the poster
        ipcRenderer.send('wt-poster', torrentKey, posterFileName)
      })
    })
  })
}

function updateTorrentProgress () {
  const progress = getTorrentProgress()
  // TODO: diff torrent-by-torrent, not once for the whole update
  if (prevProgress && util.isDeepStrictEqual(progress, prevProgress)) {
    return /* don't send heavy object if it hasn't changed */
  }
  ipcRenderer.send('wt-progress', progress)
  prevProgress = progress
}

function getTorrentProgress () {
  // First, track overall progress
  const progress = client.progress
  const hasActiveTorrents = client.torrents.some(torrent => torrent.progress !== 1)

  // Track progress for every file in each torrent
  // TODO: ideally this would be tracked by WebTorrent, which could do it
  // more efficiently than looping over torrent.bitfield
  const torrentProg = client.torrents.map(torrent => {
    const fileProg = torrent.files && torrent.files.map(file => {
      const numPieces = file._endPiece - file._startPiece + 1
      let numPiecesPresent = 0
      for (let piece = file._startPiece; piece <= file._endPiece; piece++) {
        if (torrent.bitfield.get(piece)) numPiecesPresent++
      }
      return {
        startPiece: file._startPiece,
        endPiece: file._endPiece,
        numPieces,
        numPiecesPresent
      }
    })
    return {
      torrentKey: torrent.key,
      ready: torrent.ready,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      length: torrent.length,
      bitfield: torrent.bitfield,
      files: fileProg
    }
  })

  return {
    torrents: torrentProg,
    progress,
    hasActiveTorrents
  }
}

function startServer (infoHash) {
  const torrent = client.get(infoHash)
  if (!torrent) {
    return console.log('cannot start server: torrent %s is not running', infoHash)
  }
  if (torrent.ready) startServerFromReadyTorrent(torrent)
  else torrent.once('ready', () => startServerFromReadyTorrent(torrent))
}

function startServerFromReadyTorrent (torrent) {
  if (server) return

  // start the streaming torrent-to-http server
  server = torrent.createServer()
  server.listen(0, () => {
    const port = server.address().port
    const urlSuffix = ':' + port
    const info = {
      torrentKey: torrent.key,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix,
      networkAddress: networkAddress()
    }

    ipcRenderer.send('wt-server-running', info)
    ipcRenderer.send('wt-server-' + torrent.infoHash, info)
  })
}

function stopServer () {
  if (!server) return
  const toDestroy = server
  server = null
  try {
    toDestroy.destroy()
  } catch (err) {
    console.log('error stopping server: %o', err)
  }
}

console.log('Initializing...')

function getAudioMetadata (infoHash, index) {
  const torrent = client.get(infoHash)
  const file = torrent.files[index]

  // Set initial matadata to display the filename first.
  const metadata = { title: file.name }
  ipcRenderer.send('wt-audio-metadata', infoHash, index, metadata)

  const options = {
    native: false,
    skipCovers: true,
    fileSize: file.length,
    observer: () => {
      ipcRenderer.send('wt-audio-metadata', infoHash, index, {
        common: metadata.common,
        format: metadata.format
      })
    }
  }
  const onMetadata = file.done
    // If completed; use direct file access
    ? mm.parseFile(path.join(torrent.path, file.path), options)
    // otherwise stream
    : mm.parseStream(file.createReadStream(), file.name, options)

  onMetadata
    .then(
      metadata => {
        ipcRenderer.send('wt-audio-metadata', infoHash, index, metadata)
        console.log(`metadata for file='${file.name}' completed.`)
      },
      err => {
        console.log(
          `error getting audio metadata for ${infoHash}:${index}`,
          err
        )
      }
    )
}

function selectFiles (torrentOrInfoHash, selections) {
  // Get the torrent object
  let torrent
  if (typeof torrentOrInfoHash === 'string') {
    torrent = client.get(torrentOrInfoHash)
  } else {
    torrent = torrentOrInfoHash
  }
  if (!torrent) {
    throw new Error('selectFiles: missing torrent ' + torrentOrInfoHash)
  }

  // Selections not specified?
  // Download nothing. Files are only fetched once the user plays them, so the
  // safe default is an empty selection. We still replace the default
  // whole-torrent selection with individual per-file selections, so that files
  // can be selected and deselected later on.
  if (!selections) {
    selections = new Array(torrent.files.length).fill(false)
  }

  // Selections specified incorrectly?
  if (selections.length !== torrent.files.length) {
    throw new Error('got ' + selections.length + ' file selections, ' +
      'but the torrent contains ' + torrent.files.length + ' files')
  }

  // Remove default selection (whole torrent)
  torrent.deselect(0, torrent.pieces.length - 1, false)

  // Add selections (individual files)
  const selected = new Set()
  selections.forEach((selection, i) => {
    const file = torrent.files[i]
    if (selection) {
      selected.add(i)
      file.select()
    } else {
      file.deselect()
    }
  })
  selectedFiles.set(torrent.infoHash, selected)
  console.log('torrent %s: downloading %d of %d files',
    torrent.name, selected.size, torrent.files.length)
}

/**
 * The user is resuming a video partway through, so fetch the pieces around that
 * point before anything else. Without this the download starts at the beginning
 * of the file, which is the part they are not about to watch.
 */
function prioritizePosition (infoHash, index, seconds, duration) {
  const torrent = client.get(infoHash)
  if (!torrent || !torrent.ready) return
  const file = torrent.files[index]
  if (!file || !duration || !isFinite(duration) || duration <= 0) return

  // Videos are roughly constant bitrate over short spans, so time maps closely
  // enough onto bytes for picking a starting piece
  const fraction = Math.max(0, Math.min(0.99, seconds / duration))
  const offset = Math.floor(file.length * fraction)
  const startPiece = Math.min(
    file._startPiece + Math.floor(offset / torrent.pieceLength),
    file._endPiece)

  console.log('resuming %s at %ds: fetching from piece %d of %d-%d',
    file.name, Math.round(seconds), startPiece, file._startPiece, file._endPiece)

  // Ask for everything from the resume point on, ahead of the rest of the file
  torrent.select(startPiece, file._endPiece, 1)
  // ...and treat the next few pieces as urgent, so playback can start
  torrent.critical(startPiece, Math.min(startPiece + 4, file._endPiece))
}

/**
 * Fetches one extra small file from the torrent - a subtitle, say - alongside
 * the video being watched, and says when it has landed. Nothing else in the
 * torrent is touched.
 */
function fetchFile (infoHash, index) {
  const torrent = client.get(infoHash)
  if (!torrent || !torrent.ready) return
  const file = torrent.files[index]
  if (!file) return

  const filePath = path.join(torrent.path, file.path)
  const announce = () => ipcRenderer.send('wt-file-ready', infoHash, index, filePath)

  if (file.done) return announce()

  console.log('fetching %s (%d bytes) alongside the video', file.name, file.length)

  const selected = selectedFiles.get(infoHash) || new Set()
  selected.add(index)
  selectedFiles.set(infoHash, selected)

  // Ahead of the video in the queue: it is tiny, and playback is waiting on it
  file.select(5)
  torrent.critical(file._startPiece, file._endPiece)
  file.once('done', announce)
}

// The user closed the player or moved to another file: stop asking peers for
// data, but keep whatever has already been downloaded. The torrent object stays
// alive so that going back to a file watched earlier plays straight away
// instead of downloading it all over again.
function stopDownloading (infoHash) {
  selectedFiles.delete(infoHash)
  stopServer()

  const torrent = client.get(infoHash)
  if (!torrent || !torrent.ready) return

  console.log('--- STOP DOWNLOADING: %s (keeping %d bytes already fetched)',
    infoHash, torrent.downloaded)

  // Drop every selection, including the whole-torrent one WebTorrent adds when
  // it first reads the metadata
  if (torrent.pieces && torrent.pieces.length > 0) {
    torrent.deselect(0, torrent.pieces.length - 1, false)
  }
  torrent.files.forEach(file => file.deselect())
  selectedFiles.set(infoHash, new Set())
}

// The torrent was removed from the list: tear it down and delete the temp files
// it wrote. Nothing else deletes a torrent's data while the app is running.
function deleteTorrentData (infoHash) {
  const torrent = client.get(infoHash)
  selectedFiles.delete(infoHash)

  if (!torrent) return

  const dir = torrent.path
  if (server) server = null // the torrent owns the server and tears it down

  if (!isInTempFolder(dir)) {
    // Points at files of the user's own, such as a torrent they created and are
    // seeding. Stop the torrent, but never touch the data.
    torrent.destroy()
    return
  }

  torrent.destroy({ destroyStore: true }, err => {
    if (err) console.log('error destroying torrent %s: %o', infoHash, err)
    deletePath(dir)
  })
}

// Clear the whole temp folder. Runs at startup, so a crash or a shutdown that
// cut the app off can never leave files behind, and again on quit.
// Calls back once every file handle has been closed and the folder is gone.
function wipeTemp (cb) {
  cb = cb || (() => {})
  server = null
  selectedFiles.clear()

  // Only torrents inside a temp folder are ours to delete
  const torrents = client.torrents.filter(torrent => isInTempFolder(torrent.path))

  const clearAll = () => {
    // The folder in use, plus any left over from an earlier choice of location
    for (const dir of [tempRoot, ...staleTempRoots]) deletePathSync(dir)

    // Put the folder back, with the marker that says it is ours to delete.
    // Without this the next cleanup would refuse to touch it. At quit the main
    // process removes the empty folder again, after this has run.
    try {
      tempPathLib.ensure(tempRoot)
    } catch (err) {
      console.log('could not recreate %s: %o', tempRoot, err)
    }

    cb()
  }

  if (torrents.length === 0) return clearAll()

  let pending = torrents.length
  torrents.forEach(torrent => {
    // destroyStore closes every open file handle before unlinking, which is
    // what makes this work on Windows
    torrent.destroy({ destroyStore: true }, () => {
      if (--pending === 0) clearAll()
    })
  })
}

// Recursively deletes a file or folder, but only inside our own temp folder:
// a bug here must never be able to delete the user's own files.
function deletePath (target) {
  const resolved = resolveInTempFolder(target)
  if (!resolved) return

  fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }, err => {
    if (err) console.log('error deleting %s: %o', resolved, err)
    else console.log('deleted %s', resolved)
  })
}

function deletePathSync (target) {
  const resolved = resolveInTempFolder(target)
  if (!resolved) return

  // Windows will not let a file go until the last handle on it is closed, so
  // keep trying for a few seconds rather than giving up on the first refusal
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      if (!fs.existsSync(resolved)) {
        console.log('deleted %s', resolved)
        return
      }
    } catch (err) {
      if (attempt === 19) console.log('error deleting %s: %o', resolved, err)
    }
    sleepSync(150)
  }
  console.log('gave up deleting %s: still in use', resolved)
}

// Blocks this process briefly. Only used while shutting down, where there is
// nothing left to keep responsive.
function sleepSync (ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Returns an absolute path, but only if it sits inside one of our temp folders
function resolveInTempFolder (target) {
  if (!target) return null

  if (!isInTempFolder(target)) {
    console.log('refusing to delete %s: outside %s', target, tempRoot)
    return null
  }

  // Never delete a folder we did not create. The marker file is written when
  // the folder is set up, which is what makes pointing the setting at, say,
  // the Downloads folder harmless.
  const roots = [tempRoot, ...staleTempRoots]
  const owner = roots.find(root => tempPathLib.isInside(target, root))
  if (owner && !tempPathLib.isOurs(owner)) {
    console.log('refusing to delete %s: %s was not created by this app', target, owner)
    return null
  }

  return path.resolve(target)
}

// Is this path our temporary scratch space, rather than somewhere of the user's?
function isInTempFolder (target) {
  if (!target) return false
  return [tempRoot, ...staleTempRoots].some(root => tempPathLib.isInside(target, root))
}

// Gets a WebTorrent handle by torrentKey
// Throws an Error if we're not currently torrenting anything w/ that key
function getTorrent (torrentKey) {
  const ret = client.torrents.find((x) => x.key === torrentKey)
  if (!ret) throw new TorrentKeyNotFoundError(torrentKey)
  return ret
}

// TODO: remove this once the following bugs are fixed:
// https://bugs.chromium.org/p/chromium/issues/detail?id=490143
// https://github.com/electron/electron/issues/7212
window.testOfflineMode = () => {
  console.log('Test, going OFFLINE')
  client = window.client = new WebTorrent({
    peerId: PEER_ID,
    tracker: false,
    dht: false,
    webSeeds: false
  })
  listenToClientEvents()
}
