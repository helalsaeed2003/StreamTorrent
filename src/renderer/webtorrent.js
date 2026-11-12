// To keep the UI snappy, we run WebTorrent in its own hidden window, a separate
// process from the main window.
console.time('init')

const crypto = require('crypto')
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

/**
 * A short record of what the torrent process has been asked to do, kept in
 * memory so that a stream that never starts can be looked into afterwards.
 */
window.__trace = []
function trace (...args) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + args.join(' ')
  window.__trace.push(line)
  if (window.__trace.length > 400) window.__trace.shift()
  console.log(line)
}

// WebTorrent-to-HTTP streaming sever
let server = null
let serverTorrentHash = null
let serverInfo = null

// Used for diffing, so we only send progress updates when necessary
let prevSignature = null

// The torrent whose file list the user is looking at. Its per-file progress is
// worked out in full; for every other torrent only the files actually asked
// for are reported, because a torrent can hold tens of thousands of files and
// working out all of them, every second, leaves no time for anything else.
let focusedInfoHash = null

// Per-file progress, kept between updates so that a torrent nothing is being
// downloaded for is not worked out again and again
const fileProgressCache = new Map()

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
  ipcRenderer.on('wt-focus-torrent', (e, infoHash) =>
    setFocusedTorrent(infoHash))
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
  trace('startTorrenting', infoHash, 'alreadyRunning', !!running)
  if (running) {
    console.log('torrent %s is already running, reusing it', infoHash)
    running.key = torrentKey
    if (running.ready) {
      selectFiles(running, selections)
      const info = getTorrentInfo(running)
      ipcRenderer.send('wt-ready', torrentKey, info)
      ipcRenderer.send('wt-ready-' + running.infoHash, torrentKey, info)
    } else {
      running.once('ready', () => {
        selectFiles(running, selections)
        // The player waits to be told the torrent is ready before asking for
        // the stream. Without this, nothing ever starts playing from a torrent
        // that was already running but had not read its metadata yet.
        const info = getTorrentInfo(running)
        ipcRenderer.send('wt-ready', torrentKey, info)
        ipcRenderer.send('wt-ready-' + running.infoHash, torrentKey, info)
      })
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
  const started = Date.now()
  updateTorrentProgressInner()
  const took = Date.now() - started
  if (took > 200) trace('progressUpdate', took + 'ms')
}

function updateTorrentProgressInner () {
  // Comparing a short line of numbers, rather than walking the whole report:
  // with a torrent of tens of thousands of files the comparison alone used to
  // cost more than the second it was given
  const signature = progressSignature()
  if (signature === prevSignature) return

  prevSignature = signature
  ipcRenderer.send('wt-progress', getTorrentProgress())
}

// Everything that would make the report different, as one short string
function progressSignature () {
  return client.torrents.map(torrent => [
    torrent.key,
    torrent.ready ? 1 : 0,
    torrent.downloaded,
    torrent.downloadSpeed,
    torrent.uploadSpeed,
    torrent.numPeers,
    torrent.length,
    torrent.infoHash === focusedInfoHash ? 1 : 0
  ].join(',')).join('|')
}

function getTorrentProgress () {
  // First, track overall progress
  const progress = client.progress
  const hasActiveTorrents = client.torrents.some(torrent => torrent.progress !== 1)

  // Track progress for every file in each torrent
  // TODO: ideally this would be tracked by WebTorrent, which could do it
  // more efficiently than looping over torrent.bitfield
  const torrentProg = client.torrents.map(torrent => {
    const fileProg = fileProgressFor(torrent)
    return {
      torrentKey: torrent.key,
      ready: torrent.ready,
      progress: torrent.progress,
      downloaded: torrent.downloaded,
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      numPeers: torrent.numPeers,
      length: torrent.length,
      files: fileProg
    }
  })

  return {
    torrents: torrentProg,
    progress,
    hasActiveTorrents
  }
}

/**
 * How much of each file is here.
 *
 * For the torrent being looked at, every file. For the rest, only the files
 * the user asked for, which is all anything else needs to know and keeps a
 * torrent of tens of thousands of files from costing a second of work every
 * second.
 */
// At most this many stretches are reported. A file downloaded in scattered
// pieces could otherwise have thousands of them, which is more than the bar
// can draw and more than is worth sending every second.
const MAX_RANGES = 32

/**
 * Turns runs of pieces into fractions of the file, and keeps the list short
 * by closing up the smallest gaps between them first. Closing a gap only ever
 * claims a little more than is really there, by less than the gap itself.
 */
function asFractions (runs, numPieces) {
  if (runs.length === 0) return []

  const kept = runs.slice()

  while (kept.length > MAX_RANGES) {
    let smallest = 0
    let smallestGap = Infinity
    for (let i = 0; i < kept.length - 1; i++) {
      const gap = kept[i + 1][0] - kept[i][1]
      if (gap < smallestGap) {
        smallestGap = gap
        smallest = i
      }
    }
    kept[smallest] = [kept[smallest][0], kept[smallest + 1][1]]
    kept.splice(smallest + 1, 1)
  }

  // Rounded, so that a bar that has not visibly moved does not count as a
  // change worth sending
  const round = (value) => Math.round((value / numPieces) * 1000) / 1000

  return kept.map(([from, to]) => [round(from), round(to)])
}

function fileProgressFor (torrent) {
  const files = torrent.files
  if (!files) return null

  const cached = fileProgressCache.get(torrent.infoHash)
  const focused = torrent.infoHash === focusedInfoHash
  if (cached && cached.downloaded === torrent.downloaded && cached.focused === focused) {
    return cached.progress
  }

  const wanted = selectedFiles.get(torrent.infoHash)
  const progress = new Array(files.length)

  for (let index = 0; index < files.length; index++) {
    if (!focused && !(wanted && wanted.has(index))) continue

    const file = files[index]
    const numPieces = file._endPiece - file._startPiece + 1
    let numPiecesPresent = 0

    // Which stretches of the file are here, as fractions of it. A torrent is
    // not downloaded front to back: after a seek the pieces come down around
    // the new position, so a single number counted from the start says
    // nothing about what can be played from where the user is.
    const runs = []
    let runStart = -1

    for (let piece = file._startPiece; piece <= file._endPiece; piece++) {
      if (torrent.bitfield.get(piece)) {
        numPiecesPresent++
        if (runStart < 0) runStart = piece
      } else if (runStart >= 0) {
        runs.push([runStart - file._startPiece, piece - file._startPiece])
        runStart = -1
      }
    }
    if (runStart >= 0) runs.push([runStart - file._startPiece, numPieces])

    progress[index] = {
      numPieces,
      numPiecesPresent,
      ranges: asFractions(runs, numPieces)
    }
  }

  fileProgressCache.set(torrent.infoHash, {
    downloaded: torrent.downloaded,
    focused,
    progress
  })

  return progress
}

// The torrent whose files are on screen, so its progress is reported in full
function setFocusedTorrent (infoHash) {
  if (focusedInfoHash === infoHash) return

  // Both the one being left and the one being taken up are worked out again:
  // one shrinks to the files asked for, the other grows to all of them
  const before = focusedInfoHash
  focusedInfoHash = infoHash || null
  if (before) fileProgressCache.delete(before)
  if (focusedInfoHash) fileProgressCache.delete(focusedInfoHash)
  prevSignature = null
}

function startServer (infoHash) {
  const torrent = client.get(infoHash)
  trace('startServer', infoHash, 'found', !!torrent, 'ready', torrent ? torrent.ready : null)
  if (!torrent) {
    return console.log('cannot start server: torrent %s is not running', infoHash)
  }
  if (torrent.ready) startServerFromReadyTorrent(torrent)
  else torrent.once('ready', () => startServerFromReadyTorrent(torrent))
}

/**
 * One streaming server at a time, and it belongs to one torrent.
 *
 * Asking for a file in another torrent takes the old server down and puts a
 * new one up. Asking again for the torrent already being served answers
 * straight away, because the player is waiting to be told where the stream
 * is and would otherwise wait for ever.
 */
function startServerFromReadyTorrent (torrent) {
  trace('serverFor', torrent.infoHash, 'existing', serverTorrentHash, 'hasInfo', !!serverInfo)
  if (server && serverTorrentHash === torrent.infoHash && serverInfo) {
    return announceServer(torrent.infoHash)
  }

  if (server) stopServer()

  const own = torrent.createServer()
  server = own
  serverTorrentHash = torrent.infoHash
  serverInfo = null

  // A server that fell over is cleared away, so the next file puts up a new
  // one instead of waiting on a dead one for ever
  own.on('error', err => {
    console.log('streaming server error: %o', err)
    if (server === own) stopServer()
    ipcRenderer.send('wt-server-failed', torrent.infoHash, err.message)
  })

  own.listen(0, () => {
    if (server !== own) return

    const urlSuffix = ':' + own.address().port
    serverInfo = {
      torrentKey: torrent.key,
      localURL: 'http://localhost' + urlSuffix,
      networkURL: 'http://' + networkAddress() + urlSuffix,
      networkAddress: networkAddress()
    }

    announceServer(torrent.infoHash)
  })
}

function announceServer (infoHash) {
  trace('announceServer', infoHash, 'hasInfo', !!serverInfo)
  if (!serverInfo) return
  ipcRenderer.send('wt-server-running', serverInfo)
  ipcRenderer.send('wt-server-' + infoHash, serverInfo)
}

function stopServer () {
  trace('stopServer', 'had', serverTorrentHash)
  if (!server) return
  const toDestroy = server
  server = null
  serverTorrentHash = null
  serverInfo = null
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

/**
 * Says that we want something after all.
 *
 * A torrent with nothing selected counts as finished, and a finished
 * torrent turns away every peer its trackers offer: lib/torrent.js drops a
 * peer address outright while torrent.done is set. Nothing here is selected
 * until the user plays or preloads a file, so every torrent starts out
 * finished, and asking for a file afterwards does not work that out again -
 * the torrent sits there with nobody to ask and no way to get anybody.
 *
 * So it is worked out here, after every change to what is wanted. When that
 * turns a finished torrent back into an unfinished one the trackers are
 * asked again straight away, since the peers they offered while it was
 * finished were thrown away and the next announce can be half an hour off.
 */
function wantMore (torrent) {
  if (!torrent || torrent.destroyed || !torrent.ready) return
  if (!torrent.done) return

  // Is any of what has been asked for still missing? Worked out here rather
  // than by the engine's own _checkDone, which counts a torrent with nothing
  // asked for as finished when it is called on a fresh one and as unfinished
  // when it is called again - and a torrent nobody has asked anything of
  // should stay quiet rather than go looking for peers.
  let missing = false
  for (const selection of torrent._selections || []) {
    for (let piece = selection.from; piece <= selection.to; piece++) {
      if (!torrent.bitfield.get(piece)) {
        missing = true
        break
      }
    }
    if (missing) break
  }

  if (!missing) return

  console.log('torrent %s: asking the trackers again, now that there is ' +
    'something to fetch', torrent.infoHash)
  torrent.done = false
  try {
    torrent.discovery.tracker.update()
  } catch (err) {}
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

  // Drop what was being asked for, including the whole-torrent selection
  // WebTorrent adds as soon as it reads the metadata
  clearSelections(torrent)

  // Ask for the files wanted now, and only those
  const selected = new Set()
  selections.forEach((selection, i) => {
    if (!selection) return
    const file = torrent.files[i]
    if (!file) return
    selected.add(i)
    file.select()
  })
  selectedFiles.set(torrent.infoHash, selected)
  console.log('torrent %s: downloading %d of %d files',
    torrent.name, selected.size, torrent.files.length)
  wantMore(torrent)
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
  wantMore(torrent)
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
  wantMore(torrent)
  file.once('done', announce)
}

// The user closed the player or moved to another file: stop asking peers for
// data, but keep whatever has already been downloaded. The torrent object stays
// alive so that going back to a file watched earlier plays straight away
// instead of downloading it all over again.
function stopDownloading (infoHash) {
  trace('stopDownloading', infoHash)
  selectedFiles.delete(infoHash)
  stopServer()

  const torrent = client.get(infoHash)
  if (!torrent || !torrent.ready) return

  console.log('--- STOP DOWNLOADING: %s (keeping %d bytes already fetched)',
    infoHash, torrent.downloaded)

  clearSelections(torrent)
}

/**
 * Stops asking for anything at all in this torrent.
 *
 * Every selection goes at once. Taking them away one file at a time meant one
 * call per file, each of which makes WebTorrent go round every connected peer
 * again: on a torrent of tens of thousands of files that took so long that
 * nothing else could be played until the app was restarted.
 */
function clearSelections (torrent) {
  const infoHash = torrent.infoHash

  if (Array.isArray(torrent._selections)) {
    torrent._selections.length = 0
    if (typeof torrent._updateSelections === 'function') torrent._updateSelections()
  } else {
    // Whatever version this is does not keep them where we expect, so fall
    // back to taking away the ones we know we asked for
    if (torrent.pieces && torrent.pieces.length > 0) {
      torrent.deselect(0, torrent.pieces.length - 1, false)
    }
    const asked = selectedFiles.get(infoHash)
    if (asked) {
      for (const index of asked) {
        const file = torrent.files[index]
        if (file) file.deselect()
      }
    }
  }

  selectedFiles.set(infoHash, new Set())
}

// The torrent was removed from the list: tear it down and delete the temp files
// it wrote. Nothing else deletes a torrent's data while the app is running.
function deleteTorrentData (infoHash) {
  trace('deleteTorrentData', infoHash)
  const torrent = client.get(infoHash)
  selectedFiles.delete(infoHash)

  if (!torrent) return

  const dir = torrent.path
  if (server && serverTorrentHash === infoHash) {
    // The torrent owns the server and tears it down with itself
    server = null
    serverTorrentHash = null
    serverInfo = null
  }

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
  trace('wipeTemp')
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
