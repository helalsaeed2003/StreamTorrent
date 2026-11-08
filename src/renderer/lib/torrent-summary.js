module.exports = {
  getPosterPath,
  getTorrentPath,
  getTempPath,
  getByKey,
  getTorrentId,
  getFileOrFolder
}

const path = require('path')
const config = require('../../config')

// Expects a torrentSummary
// Returns an absolute path to the torrent file, or null if unavailable
function getTorrentPath (torrentSummary) {
  if (!torrentSummary || !torrentSummary.torrentFileName) return null
  return path.join(config.TORRENT_PATH, torrentSummary.torrentFileName)
}

// Expects a torrentSummary
// Returns an absolute path to the poster image, or null if unavailable
function getPosterPath (torrentSummary) {
  if (!torrentSummary || !torrentSummary.posterFileName) return null
  const posterPath = path.join(config.POSTER_PATH, torrentSummary.posterFileName)
  // Work around a Chrome bug (reproduced in vanilla Chrome, not just Electron):
  // Backslashes in URLS in CSS cause bizarre string encoding issues
  return posterPath.replace(/\\/g, '/')
}

// Expects a torrentSummary (or null, for a torrent with no info hash yet) and a
// key from state.nextStreamKey++, used only for torrents that have no info hash
// to name a folder after yet.
// Returns the temp folder this torrent streams into, inside the program's own
// folder. One stable folder per torrent, so a file watched earlier in this run
// is still there and plays instantly. The whole temp folder is cleared when the
// app starts and when it quits.
function getTempPath (torrentSummary, streamKey, tempRoot) {
  const infoHash = torrentSummary && torrentSummary.infoHash
  return path.join(tempRoot || config.TEMP_PATH, infoHash || ('new-' + streamKey))
}

// Expects a torrentSummary
// Returns a torrentID: filename, magnet URI, or infohash
function getTorrentId (torrentSummary) {
  const s = torrentSummary
  if (s.torrentFileName) { // Load torrent file from disk
    return getTorrentPath(s)
  } else { // Load torrent from DHT
    return s.magnetURI || s.infoHash
  }
}

// Expects a torrentKey or infoHash
// Returns the corresponding torrentSummary, or undefined
function getByKey (state, torrentKey) {
  if (!torrentKey) return undefined
  return state.saved.torrents.find((x) =>
    x.torrentKey === torrentKey || x.infoHash === torrentKey)
}

// Returns the path to either the file (in a single-file torrent) or the root
// folder (in  multi-file torrent)
// WARNING: assumes that multi-file torrents consist of a SINGLE folder.
// TODO: make this assumption explicit, enforce it in the `create-torrent`
// module. Store root folder explicitly to avoid hacky path processing below.
function getFileOrFolder (torrentSummary) {
  const ts = torrentSummary
  if (!ts.path || !ts.files || ts.files.length === 0) return null
  const dirname = ts.files[0].path.split(path.sep)[0]
  return path.join(ts.path, dirname)
}
