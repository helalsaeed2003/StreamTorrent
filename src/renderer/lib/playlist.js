module.exports = {
  hasNext,
  getNextIndex,
  hasPrevious,
  getPreviousIndex,
  getCurrentLocalURL
}

const TorrentSummary = require('./torrent-summary')
const TorrentPlayer = require('./torrent-player')

// Finding the neighbours means walking the file list, which can hold thousands
// of entries, and hasNext()/hasPrevious() are called on every render. Cache the
// answer until the torrent or the current file changes.
const cache = {
  infoHash: null,
  fileIndex: null,
  fileCount: -1,
  previousIndex: null,
  nextIndex: null
}

function hasNext (state) {
  updateCache(state)
  return cache.nextIndex !== null
}

function getNextIndex (state) {
  updateCache(state)
  return cache.nextIndex
}

function hasPrevious (state) {
  updateCache(state)
  return cache.previousIndex !== null
}

function getPreviousIndex (state) {
  updateCache(state)
  return cache.previousIndex
}

function getCurrentLocalURL (state) {
  return state.server
    ? state.server.localURL + '/' + state.playing.fileIndex + '/' +
      encodeURIComponent(state.playing.fileName)
    : ''
}

function updateCache (state) {
  const infoHash = state.playing.infoHash
  const fileIndex = state.playing.fileIndex
  const torrentSummary = TorrentSummary.getByKey(state, infoHash)
  const files = (torrentSummary && torrentSummary.files) || []

  if (cache.infoHash === infoHash &&
      cache.fileIndex === fileIndex &&
      cache.fileCount === files.length) {
    return
  }

  cache.infoHash = infoHash
  cache.fileIndex = fileIndex
  cache.fileCount = files.length
  cache.previousIndex = null
  cache.nextIndex = null

  const current = fileIndex == null ? null : files[fileIndex]
  if (!current) return

  // Images are browsed inside their own folder, like a photo viewer.
  // Audio and video keep running through the whole torrent, as before.
  const byImage = TorrentPlayer.isImage(current)
  const folder = byImage ? TorrentPlayer.getFolder(current) : null
  const matches = (file) => {
    if (!file) return false
    if (!byImage) return TorrentPlayer.isMedia(file)
    return TorrentPlayer.isImage(file) && TorrentPlayer.getFolder(file) === folder
  }

  for (let i = fileIndex - 1; i >= 0; i--) {
    if (matches(files[i])) { cache.previousIndex = i; break }
  }
  for (let i = fileIndex + 1; i < files.length; i++) {
    if (matches(files[i])) { cache.nextIndex = i; break }
  }
}
