/**
 * Looking through the files of a torrent by name.
 *
 * Used by the search box in the torrent's file list, and by the playlist, so
 * that Next and Previous can follow a search rather than the order the files
 * happen to be in.
 */

module.exports = {
  matchingFiles,
  matchingIndexes,
  words
}

const FileTree = require('./file-tree')

// "pmv aard" becomes ['pmv', 'aard']
function words (query) {
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * The files that match what was typed, as { file, index }.
 *
 * Every word has to appear somewhere in the file's path, so "pmv aard" finds
 * "Aardstyle/In Our Heads PMV.mp4" however the words are ordered.
 */
function matchingFiles (torrentSummary, query) {
  const parts = words(query)
  if (parts.length === 0) return []

  const matches = []
  ;((torrentSummary && torrentSummary.files) || []).forEach((file, index) => {
    if (FileTree.isPaddingFile(file)) return
    const haystack = (file.path || file.name || '').toLowerCase()
    if (parts.every(word => haystack.includes(word))) matches.push({ file, index })
  })

  return matches
}

// Just the positions in the torrent's file list, in order
function matchingIndexes (torrentSummary, query) {
  return matchingFiles(torrentSummary, query).map(match => match.index)
}
