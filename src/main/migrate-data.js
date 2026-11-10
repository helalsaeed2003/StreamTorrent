/**
 * Moves the saved data out of the folder the installer owns.
 *
 * Everything used to live in %LOCALAPPDATA%\StreamTorrent, which is where
 * Squirrel installs the program - and which it deletes outright every time
 * StreamTorrentSetup.exe is run ("burning it to the ground" in its own log).
 * The torrent list, the thumbnails, the saved .torrent files and the temporary
 * downloads all went with it, and the deep folders inside a big torrent could
 * even make that deletion fail, which is what an "Installation has failed"
 * meant.
 *
 * They live in %LOCALAPPDATA%\StreamTorrentData now, which nothing but this
 * app touches. Anything left in the old place is brought across once.
 */

module.exports = {
  run
}

const fs = require('fs')
const path = require('path')

const config = require('../config')
const log = require('./log')

function run () {
  if (process.platform !== 'win32') return
  if (config.IS_PORTABLE) return

  const local = process.env.LOCALAPPDATA
  if (!local) return

  const from = path.join(local, config.APP_NAME)
  const to = config.CONFIG_PATH
  if (path.resolve(from) === path.resolve(to)) return
  if (!fs.existsSync(from)) return

  try {
    fs.mkdirSync(to, { recursive: true })
  } catch (err) {
    return log('could not make ' + to, err)
  }

  bring(path.join(from, 'config.json'), path.join(to, 'config.json'))
  bringFolder(path.join(from, 'Torrents'), path.join(to, 'Torrents'))
  bringFolder(path.join(from, 'Posters'), path.join(to, 'Posters'))
}

// Copies one file across, unless it is already there
function bring (from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return
  try {
    fs.copyFileSync(from, to)
    log('brought ' + path.basename(from) + ' across to ' + path.dirname(to))
  } catch (err) {
    log('could not bring ' + from + ' across', err)
  }
}

// ...and everything in a folder, file by file, keeping whatever is already
// in the new place
function bringFolder (from, to) {
  if (!fs.existsSync(from)) return

  let names
  try {
    names = fs.readdirSync(from)
  } catch (err) {
    return log('could not read ' + from, err)
  }

  try {
    fs.mkdirSync(to, { recursive: true })
  } catch (err) {
    return log('could not make ' + to, err)
  }

  for (const name of names) bring(path.join(from, name), path.join(to, name))
}
