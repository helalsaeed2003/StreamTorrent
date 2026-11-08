// Builds a folder tree out of a torrent's flat file list, so that the torrent
// details view can show files the way a file explorer does.
//
// Torrents can hold thousands of files, so the tree is built once per torrent
// and cached. Rendering only walks the folders that are currently expanded,
// which keeps the list fast no matter how big the torrent is.

module.exports = {
  getTree,
  getFolderKey,
  isPaddingFile
}

const MAX_CACHED_TREES = 8

// infoHash -> { fileCount, sortByName, tree }
const cache = new Map()

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Returns the root node of the folder tree for a torrent.
// A node looks like:
//   {
//     key: 'Season 1/Extras',   // '' for the root
//     name: 'Extras',           // '' for the root
//     folders: [node, ...],     // sub-folders, sorted by name
//     files: [{ file, index }], // files directly inside this folder
//     fileCount: 42             // files in this folder and all its sub-folders
//   }
// `index` is always the file's index in torrentSummary.files, which is what
// every other part of the app (selections, progress, playback) keys off.
function getTree (torrentSummary, sortByName) {
  const files = (torrentSummary && torrentSummary.files) || []
  const infoHash = (torrentSummary && torrentSummary.infoHash) || ''
  sortByName = !!sortByName

  const cached = cache.get(infoHash)
  if (cached && cached.fileCount === files.length && cached.sortByName === sortByName) {
    return cached.tree
  }

  const tree = buildTree(files, sortByName)

  // Keep the cache small: these trees are only a render optimization
  if (cache.size >= MAX_CACHED_TREES && !cache.has(infoHash)) {
    cache.delete(cache.keys().next().value)
  }
  cache.set(infoHash, { fileCount: files.length, sortByName, tree })

  return tree
}

// The key used to remember whether a folder is expanded
function getFolderKey (infoHash, folderKey) {
  return infoHash + '|' + folderKey
}

// BEP47 padding files are an implementation detail of the torrent, not
// something the user should ever see
function isPaddingFile (file) {
  if (!file) return true
  const filePath = file.path || ''
  const name = file.name || ''
  return /[\\/]\.____padding_file[\\/]/.test(filePath) ||
    /^\.?_+padding_file/i.test(name)
}

function buildTree (files, sortByName) {
  const entries = []
  for (let index = 0; index < files.length; index++) {
    const file = files[index]
    if (!file || isPaddingFile(file)) continue
    // Torrent paths use '/' on Linux and macOS, '\' on Windows
    const parts = String(file.path || file.name || '').split(/[\\/]/).filter(Boolean)
    if (parts.length === 0) continue
    entries.push({ file, index, parts })
  }

  // A multi-file torrent wraps everything in a folder named after the torrent.
  // That name is already the title of the row, so don't show it again.
  const stripRoot = hasCommonRootFolder(entries)

  const root = makeNode('', '')
  for (const entry of entries) {
    const parts = stripRoot ? entry.parts.slice(1) : entry.parts
    let node = root
    for (let depth = 0; depth < parts.length - 1; depth++) {
      node = getOrAddFolder(node, parts[depth])
    }
    node.files.push({ file: entry.file, index: entry.index })
  }

  finalize(root, sortByName)
  return root
}

function makeNode (key, name) {
  return {
    key,
    name,
    folders: [],
    files: [],
    fileCount: 0,
    // Only used while building; removed by finalize()
    byName: new Map()
  }
}

function getOrAddFolder (parent, name) {
  let node = parent.byName.get(name)
  if (!node) {
    node = makeNode(parent.key ? parent.key + '/' + name : name, name)
    parent.byName.set(name, node)
    parent.folders.push(node)
  }
  return node
}

// True when every file sits inside the same single top-level folder
function hasCommonRootFolder (entries) {
  if (entries.length === 0) return false
  const first = entries[0].parts
  if (first.length < 2) return false
  const rootName = first[0]
  return entries.every((entry) => entry.parts.length >= 2 && entry.parts[0] === rootName)
}

// Sorts each level and totals up the file counts
function finalize (node, sortByName) {
  delete node.byName

  node.folders.sort((a, b) => collator.compare(a.name, b.name))
  if (sortByName) {
    node.files.sort((a, b) => collator.compare(a.file.name, b.file.name))
  }

  let count = node.files.length
  for (const folder of node.folders) {
    finalize(folder, sortByName)
    count += folder.fileCount
  }
  node.fileCount = count
}
