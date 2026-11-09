module.exports = torrentPoster

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const config = require('../../config')
const mediaExtensions = require('./media-extensions')

const msgNoSuitablePoster = 'Cannot generate a poster from any files in the torrent'

// How long to wait for mpv to produce a frame before giving up, in milliseconds
const POSTER_TIMEOUT = 90 * 1000

// How wide the saved poster is, in pixels. The list draws it at about half
// this, so it stays sharp on a high-DPI screen.
const POSTER_WIDTH = 640

// How far into the video the frame is taken from, in seconds. Far enough in
// to be past black frames and logos, near enough that only a few megabytes
// have to be downloaded to reach it. If the video is shorter than this, the
// first frame is used instead.
const POSTER_POSITION = '60'

function torrentPoster (torrent, cb) {
  // First, try to use a poster image if available
  const posterFile = torrent.files.filter(file => /^poster\.(jpg|png|gif)$/.test(file.name))[0]
  if (posterFile) return extractPoster(posterFile, cb)

  // 'score' each media type based on total size present in torrent
  const bestScore = ['audio', 'video', 'image'].map(mediaType => ({
    type: mediaType,
    size: calculateDataLengthByExtension(torrent, mediaExtensions[mediaType])
  })).sort((a, b) => b.size - a.size)[0] // sort descending on size

  if (bestScore.size === 0) {
    // Admit defeat, no video, audio or image had a significant presence
    return cb(new Error(msgNoSuitablePoster))
  }

  // Based on which media type is dominant we select the corresponding poster function
  switch (bestScore.type) {
    case 'audio':
      return torrentPosterFromAudio(torrent, cb)
    case 'image':
      return torrentPosterFromImage(torrent, cb)
    case 'video':
      return torrentPosterFromVideo(torrent, cb)
  }
}

/**
 * Calculate the total data size of file matching one of the provided extensions
 * @param torrent
 * @param extensions List of extension to match
 * @returns {number} total size, of matches found (>= 0)
 */
function calculateDataLengthByExtension (torrent, extensions) {
  const files = filterOnExtension(torrent, extensions)
  if (files.length === 0) return 0
  return files
    .map(file => file.length)
    .reduce((a, b) => a + b)
}

/**
 * Get the largest file of a given torrent, filtered by provided extension
 * @param torrent Torrent to search in
 * @param extensions Extension whitelist filter
 * @returns Torrent file object
 */
function getLargestFileByExtension (torrent, extensions) {
  const files = filterOnExtension(torrent, extensions)
  if (files.length === 0) return undefined
  return files.reduce((a, b) => a.length > b.length ? a : b)
}

/**
 * Filter file on a list extension, can be used to find al image files
 * @param torrent Torrent to filter files from
 * @param extensions File extensions to filter on
 * @returns {Array} Array of torrent file objects matching one of the given extensions
 */
function filterOnExtension (torrent, extensions) {
  return torrent.files.filter(file => {
    const extname = path.extname(file.name).toLowerCase()
    return extensions.indexOf(extname) !== -1
  })
}

/**
 * Returns a score how likely the file is suitable as a poster
 * @param imgFile File object of an image
 * @returns {number} Score, higher score is a better match
 */
function scoreAudioCoverFile (imgFile) {
  const fileName = path.basename(imgFile.name, path.extname(imgFile.name)).toLowerCase()
  const relevanceScore = {
    cover: 80,
    folder: 80,
    album: 80,
    front: 80,
    back: 20,
    spectrogram: -80
  }

  for (const keyword in relevanceScore) {
    if (fileName === keyword) {
      return relevanceScore[keyword]
    }
    if (fileName.indexOf(keyword) !== -1) {
      return relevanceScore[keyword]
    }
  }
  return 0
}

function torrentPosterFromAudio (torrent, cb) {
  const imageFiles = filterOnExtension(torrent, mediaExtensions.image)

  if (imageFiles.length === 0) return cb(new Error(msgNoSuitablePoster))

  const bestCover = imageFiles.map(file => ({
    file,
    score: scoreAudioCoverFile(file)
  })).reduce((a, b) => {
    if (a.score > b.score) {
      return a
    }
    if (b.score > a.score) {
      return b
    }
    // If score is equal, pick the largest file, aiming for highest resolution
    if (a.file.length > b.file.length) {
      return a
    }
    return b
  })

  const extname = path.extname(bestCover.file.name)
  bestCover.file.getBuffer((err, buf) => cb(err, buf, extname))
}

/**
 * Grabs a frame from the largest video in the torrent, using the bundled mpv
 * rather than a <video> tag. mpv opens everything the player can open,
 * including HEVC and 10-bit MKVs that Chromium cannot decode, so a poster is
 * made for the same files the app can actually play.
 *
 * Only the pieces up to the chosen moment are downloaded, and only once: the
 * JPEG is kept in the poster folder from then on. The moment is measured in
 * seconds rather than as a fraction of the video, so the cost does not grow
 * with the size of the file.
 */
function torrentPosterFromVideo (torrent, cb) {
  const file = getLargestFileByExtension(torrent, mediaExtensions.video)
  const index = torrent.files.indexOf(file)

  let dir = null
  let child = null
  let timer = null
  let finished = false

  const server = torrent.createServer(0)
  server.listen(0, onListening)

  function finish (err, buf) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    if (child) child.kill()
    try {
      server.destroy()
    } catch (e) {
      // The torrent may already have taken the server down with it
    }
    if (dir) fs.rm(dir, { recursive: true, force: true }, () => {})
    if (err) return cb(err)
    cb(null, buf, '.jpg')
  }

  function onListening () {
    const port = server.address().port
    const url = 'http://localhost:' + port + '/' + index + '/' +
      encodeURIComponent(file.name)

    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtorrent-poster-'))
    } catch (err) {
      return finish(err)
    }

    timer = setTimeout(() => finish(new Error('Timed out making a poster')),
      POSTER_TIMEOUT)

    grab(url, POSTER_POSITION, (err, buf) => {
      if (!err) return finish(null, buf)
      // Nothing there: the video may be shorter than that, so settle for the
      // very first frame
      grab(url, '0', (err, buf) => {
        if (err) return finish(err)
        finish(null, buf)
      })
    })
  }

  // Runs mpv once, writing a single frame to a JPEG, and reads it back
  function grab (url, start, done) {
    if (finished) return
    const out = path.join(dir, 'poster-' + start + '.jpg')

    child = spawn(config.MPV_PATH, [
      '--no-config',
      '--no-terminal',
      '--msg-level=all=no',
      // Nothing is played: one frame is decoded and written out
      '--no-audio',
      '--no-sub',
      '--frames=1',
      '--start=' + start,
      // Decode in software. The frame has to come back to main memory to be
      // encoded, and not every machine can copy it back from the GPU.
      '--hwdec=no',
      '--vf=scale=' + POSTER_WIDTH + ':-2',
      // Video is usually limited-range, which the JPEG encoder refuses to take
      // unless it is told not to insist on the standard
      '--ovcopts=strict=-1',
      '--o=' + out,
      url
    ], { windowsHide: true })

    child.on('error', err => done(err))
    child.on('exit', () => {
      fs.readFile(out, (err, buf) => {
        if (err || !buf || buf.length === 0) {
          return done(new Error(msgNoSuitablePoster))
        }
        done(null, buf)
      })
    })
  }
}

function torrentPosterFromImage (torrent, cb) {
  const file = getLargestFileByExtension(torrent, mediaExtensions.image)
  extractPoster(file, cb)
}

function extractPoster (file, cb) {
  const extname = path.extname(file.name)
  file.getBuffer((err, buf) => cb(err, buf, extname))
}
