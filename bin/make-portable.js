#!/usr/bin/env node
/**
 * Makes the portable zip out of what electron-builder already unpacked.
 *
 * The portable build is the same files as the installer, plus an empty
 * "Portable Settings" folder beside the executable. The app looks for that
 * folder at startup, and when it is there it keeps its settings, its torrent
 * list and its scratch space inside it rather than in the user's AppData, so
 * the whole thing can live on a memory stick and leave nothing behind.
 *
 * Run it after `npm run dist`, which leaves dist/win-unpacked in place.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')

const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked')
// A fixed name, so the download link on the front page keeps working from one
// release to the next. The version is in Help > About and on the release page.
const OUT = path.join(ROOT, 'dist', 'StreamTorrent-win.zip')

function find7z () {
  const bundled = path.join(ROOT, 'node_modules', 'electron-winstaller',
    'vendor', '7z.exe')
  if (fs.existsSync(bundled)) return bundled

  for (const candidate of ['7z', '7z.exe', '7za.exe',
    'C:\\Program Files\\7-Zip\\7z.exe']) {
    try {
      execFileSync(candidate, ['i'], { stdio: 'ignore' })
      return candidate
    } catch (err) {}
  }

  throw new Error('7-Zip was not found')
}

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(a, b)
    else if (entry.isFile()) fs.copyFileSync(a, b)
  }
}

function main () {
  if (!fs.existsSync(UNPACKED)) {
    throw new Error('dist/win-unpacked is not there. Run `npm run dist` first.')
  }

  // Built in a folder of its own, so the "Portable Settings" marker is not
  // left behind in win-unpacked - the installer must not carry it, or every
  // installed copy would behave like a portable one
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtorrent-portable-'))
  const staged = path.join(work, 'StreamTorrent-win32-x64')

  console.log('Copying the unpacked app...')
  copyDir(UNPACKED, staged)

  fs.mkdirSync(path.join(staged, 'Portable Settings', 'Downloads'),
    { recursive: true })
  fs.mkdirSync(path.join(staged, 'Portable Settings', 'Temp'),
    { recursive: true })

  fs.rmSync(OUT, { force: true })
  console.log('Zipping...')
  execFileSync(find7z(), ['a', '-tzip', '-mx=5', OUT, staged + path.sep + '*'],
    { stdio: 'ignore' })

  fs.rmSync(work, { recursive: true, force: true })

  const mb = (fs.statSync(OUT).size / 1048576).toFixed(0)
  console.log('Portable build: ' + path.relative(ROOT, OUT) + ' (' + mb + ' MB)')
}

try {
  main()
} catch (err) {
  console.error('Could not make the portable build: ' + err.message)
  process.exit(1)
}
