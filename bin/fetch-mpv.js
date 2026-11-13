#!/usr/bin/env node
/**
 * Fetches the mpv video engine that StreamTorrent plays video with.
 *
 * mpv.exe is 116 MB, which is more than GitHub will take in a repository, so
 * it is not kept in git. This downloads the exact build the app was made
 * against and checks it against the hashes below before anything is unpacked
 * into vendor/. Run it once after cloning, and again whenever MPV is changed
 * here; bin/package.js will not build an installer without it.
 *
 *   npm run fetch-mpv            fetch it if vendor/mpv is missing or wrong
 *   npm run fetch-mpv -- --force fetch it again whatever is there
 *
 * It is fetched from the first of three places that answers, and whichever
 * one it came from has to match the hashes below.
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

// The build the app is made against. Change all of this together.
//
// mpv publishes no Windows binaries of its own - mpv.io/installation says so
// outright, and points at other people's builds - so this is shinchiro's,
// which is the one it points at first. Three places are tried in turn, and
// all three are checked against the same hashes, so a swapped file is refused
// whichever it came from.
const MPV = {
  version: 'v0.42.0-5-g55d3feb45',
  built: '2026-11-08',
  from: [
    // A copy kept with this project's own releases, which nothing clears away
    'https://github.com/helalsaeed2003/StreamTorrent/releases/download/' +
      'mpv-20261108/mpv-x86_64-20261108-git-55d3feb45c.7z',
    // The same build on the same author's SourceForge, which keeps its
    // older files rather than rolling them off
    'https://downloads.sourceforge.net/project/mpv-player-windows/64bit/' +
      'mpv-x86_64-20261108-git-55d3feb45c.7z',
    // Where it was built. These are cleared away after about a month.
    'https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/' +
      '20261108/mpv-x86_64-20261108-git-55d3feb45c.7z'
  ],
  archiveSha256:
    '465faafbf90527421ccc304870f02e59f3f47d3361a6f526ef95f40f8f2c2459',
  // What has to come out of it, and what each one must hash to
  files: {
    'mpv.exe':
      '4339290369818126ff221b40c32b59ea768678418ca66e9cfce9ff4c478b3571',
    'd3dcompiler_43.dll':
      '4b074a3976399dc735484f5d43d04b519b7bdee8ac719d9ab8ed6bd4e6be0345'
  }
}

const ROOT = path.join(__dirname, '..')
const DEST = path.join(ROOT, 'vendor', 'mpv')

function sha256 (file) {
  return crypto.createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex')
}

// Already here and unchanged? Then there is nothing to do.
function alreadyGood () {
  for (const [name, want] of Object.entries(MPV.files)) {
    const file = path.join(DEST, name)
    if (!fs.existsSync(file)) return false
    if (sha256(file) !== want) {
      console.log(name + ' is not the build this version expects')
      return false
    }
  }
  return true
}

// 7z is on the PATH on GitHub's Windows runners; locally the copy that comes
// with electron-winstaller will do
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

  throw new Error('7-Zip was not found. Install it, or run `npm install` ' +
    'first so the copy that comes with electron-winstaller is there.')
}

async function download (url, to) {
  process.stdout.write('  ' + url + '\n')
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error('the server said ' + res.status + ' ' + res.statusText)

  const total = Number(res.headers.get('content-length') || 0)
  const chunks = []
  let got = 0
  let shown = -1

  for await (const chunk of res.body) {
    chunks.push(chunk)
    got += chunk.length
    const percent = total ? Math.floor(100 * got / total / 5) * 5 : -1
    if (percent !== shown && percent >= 0) {
      shown = percent
      process.stdout.write('\r  ' + percent + '%   ')
    }
  }
  process.stdout.write('\r               \r')

  fs.writeFileSync(to, Buffer.concat(chunks))
}

async function main () {
  const force = process.argv.includes('--force')

  if (!force && alreadyGood()) {
    console.log('mpv ' + MPV.version + ' is already in vendor/mpv')
    return
  }

  console.log('Fetching mpv ' + MPV.version + ' (built ' + MPV.built + ')')

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtorrent-mpv-'))
  const archive = path.join(work, 'mpv.7z')

  let fetched = false
  const tried = []
  for (const url of MPV.from) {
    try {
      await download(url, archive)
      fetched = true
      break
    } catch (err) {
      tried.push(url + ' -> ' + err.message)
    }
  }

  if (!fetched) {
    fs.rmSync(work, { recursive: true, force: true })
    throw new Error('could not download mpv:\n  ' + tried.join('\n  '))
  }

  const got = sha256(archive)
  if (got !== MPV.archiveSha256) {
    fs.rmSync(work, { recursive: true, force: true })
    throw new Error('the download is not the file this version expects.\n' +
      '  expected ' + MPV.archiveSha256 + '\n' +
      '  got      ' + got + '\n' +
      'Nothing has been unpacked.')
  }
  console.log('  the download matches its hash')

  const names = Object.keys(MPV.files)
  execFileSync(find7z(), ['e', archive, '-o' + work, '-y', ...names],
    { stdio: 'ignore' })

  // Every file is checked before any of it is put in place
  for (const [name, want] of Object.entries(MPV.files)) {
    const file = path.join(work, name)
    if (!fs.existsSync(file)) {
      fs.rmSync(work, { recursive: true, force: true })
      throw new Error(name + ' was not in the archive')
    }
    const hash = sha256(file)
    if (hash !== want) {
      fs.rmSync(work, { recursive: true, force: true })
      throw new Error(name + ' is not the file this version expects.\n' +
        '  expected ' + want + '\n' +
        '  got      ' + hash)
    }
    console.log('  ' + name + ' matches its hash')
  }

  fs.mkdirSync(DEST, { recursive: true })
  for (const name of names) {
    fs.copyFileSync(path.join(work, name), path.join(DEST, name))
  }
  fs.rmSync(work, { recursive: true, force: true })

  console.log('mpv ' + MPV.version + ' is in ' + path.relative(ROOT, DEST))
}

main().catch(err => {
  console.error('\nCould not fetch mpv: ' + err.message)
  process.exit(1)
})
