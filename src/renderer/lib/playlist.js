module.exports = {
  hasNext,
  getNextIndex,
  hasPrevious,
  getPreviousIndex,
  getIndexAhead,
  getUpcomingIndexes,
  getPosition,
  getCurrentLocalURL,
  getLocalURL
}

const TorrentSummary = require('./torrent-summary')
const TorrentPlayer = require('./torrent-player')
const FileSearch = require('./file-search')

// Walking the file list means touching thousands of entries, and these are
// called on every render, so the list of what Next and Previous step through
// is worked out once and kept until the torrent, the folder or the search
// changes. Where we are inside it is cheap to look up again.
const cache = {
  key: null,
  list: [],
  fileIndex: null,
  at: -1
}

function hasNext (state) {
  return getNextIndex(state) !== null
}

function getNextIndex (state) {
  return getIndexAhead(state, 1)
}

function hasPrevious (state) {
  return getPreviousIndex(state) !== null
}

function getPreviousIndex (state) {
  return getIndexAhead(state, -1)
}

/**
 * The file `offset` steps from the one playing, or null when that is past
 * either end. Stepping by ten runs off the end all the time, so a jump that
 * is too far lands on the last one that exists rather than nowhere.
 */
function getIndexAhead (state, offset, clamp) {
  updateCache(state)
  if (cache.at < 0) return null

  let to = cache.at + offset
  if (clamp) to = Math.max(0, Math.min(cache.list.length - 1, to))
  if (to < 0 || to >= cache.list.length || to === cache.at) return null

  return cache.list[to]
}

// The next few files, for fetching ahead of where the user is
function getUpcomingIndexes (state, count) {
  updateCache(state)
  if (cache.at < 0 || !(count > 0)) return []
  return cache.list.slice(cache.at + 1, cache.at + 1 + count)
}

// Where we are in the folder, as "3 of 129". Null when there is no list.
function getPosition (state) {
  updateCache(state)
  if (cache.at < 0) return null
  return { at: cache.at + 1, total: cache.list.length }
}

/**
 * The search that Next and Previous should follow, or null to walk the
 * torrent in order. Only while the search box is open, and only if the
 * preference is on.
 */
function searchInForce (state) {
  const prefs = (state.saved && state.saved.prefs) || {}
  if (prefs.playlistFollowsSearch === false) return null

  const find = state.find
  if (!find || !find.active) return null

  const query = String(find.query || '').trim()
  return query || null
}

function getCurrentLocalURL (state) {
  return getLocalURL(state, state.playing.fileIndex, state.playing.fileName)
}

// The address the built-in server serves one file of the playing torrent at
function getLocalURL (state, index, name) {
  if (!state.server || index == null) return ''

  let fileName = name
  if (fileName == null) {
    const torrentSummary = TorrentSummary.getByKey(state, state.playing.infoHash)
    const file = torrentSummary && torrentSummary.files && torrentSummary.files[index]
    fileName = file && file.name
  }
  if (fileName == null) return ''

  return state.server.localURL + '/' + index + '/' + encodeURIComponent(fileName)
}

function updateCache (state) {
  const infoHash = state.playing.infoHash
  const fileIndex = state.playing.fileIndex
  const torrentSummary = TorrentSummary.getByKey(state, infoHash)
  const files = (torrentSummary && torrentSummary.files) || []
  const query = searchInForce(state)
  const current = fileIndex == null ? null : files[fileIndex]

  // Images are browsed inside their own folder, like a photo viewer. Audio
  // and video keep running through the whole torrent, as before.
  const byImage = !!current && TorrentPlayer.isImage(current)
  const folder = byImage ? TorrentPlayer.getFolder(current) : null

  const key = [infoHash, files.length, query, byImage ? 'image' : 'media', folder]
    .join('\u0000')

  if (cache.key !== key) {
    cache.key = key
    cache.list = current ? buildList(torrentSummary, files, query, byImage, folder) : []
    cache.fileIndex = null
  }

  if (cache.fileIndex !== fileIndex) {
    cache.fileIndex = fileIndex
    cache.at = cache.list.indexOf(fileIndex)

    // Opening something the search did not find leaves it outside the list it
    // built, so fall back to walking the folder, as it did before the search
    if (cache.at < 0 && query && current) {
      cache.list = buildList(torrentSummary, files, null, byImage, folder)
      cache.at = cache.list.indexOf(fileIndex)
    }
  }
}

// Every file Next and Previous may land on, in the order they are stepped
// through
function buildList (torrentSummary, files, query, byImage, folder) {
  // With a search open, Next and Previous step through what was found rather
  // than through the torrent in the order its files happen to be in
  if (query) {
    const found = FileSearch.matchingIndexes(torrentSummary, query)
      .filter(index => TorrentPlayer.isPlayable(files[index]))
    if (found.length > 0) return found
  }

  const list = []
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!file) continue
    if (byImage) {
      if (TorrentPlayer.isImage(file) && TorrentPlayer.getFolder(file) === folder) {
        list.push(i)
      }
    } else if (TorrentPlayer.isMedia(file)) {
      list.push(i)
    }
  }
  return list
}
