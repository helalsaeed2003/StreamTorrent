module.exports = {
  isPlayable,
  isMedia,
  isVideo,
  isAudio,
  isImage,
  isTorrent,
  isMagnetLink,
  isPlayableTorrentSummary,
  getFileExtension,
  getFolder
}

const path = require('path')

const mediaExtensions = require('./media-extensions')

// Checks whether a fileSummary or file path is something we can show in the app,
// based on the file extension: audio/video in the player, images in the viewer
function isPlayable (file) {
  return isVideo(file) || isAudio(file) || isImage(file)
}

// Timeline-based media (has a duration, uses the <video>/<audio> player)
function isMedia (file) {
  return isVideo(file) || isAudio(file)
}

// Checks whether a fileSummary or file path is playable video
function isVideo (file) {
  return mediaExtensions.video.includes(getFileExtension(file))
}

// Checks whether a fileSummary or file path is playable audio
function isAudio (file) {
  return mediaExtensions.audio.includes(getFileExtension(file))
}

// Checks whether a fileSummary or file path is an image we can show
function isImage (file) {
  return mediaExtensions.image.includes(getFileExtension(file))
}

// Checks if the argument is either:
// - a string that's a valid filename ending in .torrent
// - a file object where obj.name is ends in .torrent
// - a string that's a magnet link (magnet://...)
function isTorrent (file) {
  return isTorrentFile(file) || isMagnetLink(file)
}

function isTorrentFile (file) {
  return getFileExtension(file) === '.torrent'
}

function isMagnetLink (link) {
  return typeof link === 'string' && /^(stream-)?magnet:/.test(link)
}

function getFileExtension (file) {
  const name = typeof file === 'string' ? file : file.name
  return path.extname(name).toLowerCase()
}

// Returns the folder a file lives in, relative to the torrent, as a '/' joined
// string ('' for files at the top level). Torrent file paths use '/' on Linux
// and macOS and '\' on Windows, so both separators are accepted.
function getFolder (file) {
  const filePath = typeof file === 'string' ? file : file.path
  if (!filePath) return ''
  const parts = filePath.split(/[\\/]/)
  parts.pop()
  return parts.join('/')
}

function isPlayableTorrentSummary (torrentSummary) {
  return torrentSummary.files && torrentSummary.files.some(isPlayable)
}
