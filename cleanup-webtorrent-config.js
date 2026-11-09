// Undoes the marks that testing left on the real WebTorrent config:
//  - removes the "Test Collection" torrent that was added as a fixture
//  - points any torrent whose saved path was rewritten to the Streams scratch
//    folder back at the download folder
//  - strips the "played" flags the modified build wrote
//
// File selections are deliberately left as they are: the original values are
// not recoverable, and all-false downloads nothing, while all-true would make
// the stock app fetch every file of a 3490-file torrent if it were resumed.
//
// Usage: node cleanup-config.js [--apply] [--wait-for-exit] [--config <path>]

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const WAIT = args.includes('--wait-for-exit')
const cfgArgIndex = args.indexOf('--config')
const CONFIG = cfgArgIndex >= 0
  ? args[cfgArgIndex + 1]
  : path.join(process.env.LOCALAPPDATA, 'WebTorrent', 'config.json')

const CONFIG_DIR = path.dirname(CONFIG)
const STREAMS = path.join(CONFIG_DIR, 'Streams')
const TORRENT_DIR = path.join(CONFIG_DIR, 'Torrents')
const POSTER_DIR = path.join(CONFIG_DIR, 'Posters')

// The fixture torrents created for testing
const TEST_HASHES = new Set([
  '61aa775e43acd270096d927b955a8ffd9d6337a4',
  '37f9e1baefa45ed4af511ab4038c336321009d51'
])

// A scratch path written by the modified build looks like
//   ...\WebTorrent\Streams\<40 hex>-<n>   or   ...\Streams\new-<n>
// Match on the shape, not on this machine's folder, so the check works
// whichever config file is being cleaned.
const SCRATCH_PATH = /[\\/]Streams[\\/](?:[0-9a-f]{40}|new)-\d+$/i
const isScratchPath = p => !!p && (SCRATCH_PATH.test(p) || String(p).startsWith(STREAMS))

// Only guard the real config against a running app; a copy can be edited freely
const REAL_CONFIG = path.resolve(CONFIG).toLowerCase() ===
  path.resolve(path.join(process.env.LOCALAPPDATA, 'WebTorrent', 'config.json')).toLowerCase()

function isRunning () {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WebTorrent.exe', '/NH'], {
      encoding: 'utf8', windowsHide: true
    })
    return /WebTorrent\.exe/i.test(out)
  } catch (err) {
    return false
  }
}

function sleep (ms) {
  // Synchronous wait, so the whole script stays simple and sequential
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function main () {
  if (WAIT) {
    const deadline = Date.now() + 45 * 60 * 1000
    let announced = false
    while (isRunning()) {
      if (!announced) {
        console.log('WebTorrent is still running - waiting for it to be closed...')
        announced = true
      }
      if (Date.now() > deadline) {
        console.log('TIMEOUT: WebTorrent was still running after 45 minutes. Nothing changed.')
        process.exit(3)
      }
      sleep(3000)
    }
    console.log('WebTorrent is closed. Cleaning up.')
    sleep(1500) // let its final state save land first
  } else if (REAL_CONFIG && isRunning() && APPLY) {
    console.log('REFUSING: WebTorrent is running and would overwrite the file. Nothing changed.')
    process.exit(2)
  }

  const raw = fs.readFileSync(CONFIG, 'utf8')
  const cfg = JSON.parse(raw)
  const downloadPath = (cfg.prefs && cfg.prefs.downloadPath) || ''
  const actions = []

  // 1. Drop the test fixture torrent
  const before = cfg.torrents.length
  const removed = cfg.torrents.filter(t =>
    TEST_HASHES.has(t.infoHash) || (t.name === 'Test Collection' && isScratchPath(t.path)))
  cfg.torrents = cfg.torrents.filter(t => !removed.includes(t))
  removed.forEach(t => actions.push(`remove torrent "${t.name}" (${t.infoHash})`))
  if (before === cfg.torrents.length && removed.length === 0) actions.push('no test torrent found (already gone)')

  // 2. Put rewritten paths back
  cfg.torrents.forEach(t => {
    if (isScratchPath(t.path)) {
      actions.push(`reset path of "${t.name}": ${t.path} -> ${downloadPath}`)
      t.path = downloadPath
    }
  })

  // 3. Strip the "played" flags written by the modified build
  let playedCleared = 0
  cfg.torrents.forEach(t => {
    (t.files || []).forEach(f => {
      if (f.played !== undefined) { delete f.played; playedCleared++ }
    })
  })
  if (playedCleared) actions.push(`clear ${playedCleared} "played" flag(s)`)

  // 4. Delete the fixture's saved .torrent and poster files
  const sideFiles = []
  removed.forEach(t => {
    if (t.torrentFileName) sideFiles.push(path.join(TORRENT_DIR, t.torrentFileName))
    if (t.posterFileName) sideFiles.push(path.join(POSTER_DIR, t.posterFileName))
  })
  sideFiles.forEach(f => { if (fs.existsSync(f)) actions.push(`delete ${f}`) })

  // 5. The scratch folder itself
  if (fs.existsSync(STREAMS)) actions.push(`delete scratch folder ${STREAMS}`)

  console.log('\nPlanned changes:')
  actions.forEach(a => console.log('  - ' + a))
  console.log(`\nTorrents left: ${cfg.torrents.length}`)
  cfg.torrents.forEach(t => console.log(`  * ${t.name} | status=${t.status} | path=${t.path} | ` +
    `selected=${(t.selections || []).filter(Boolean).length}/${(t.files || []).length}`))

  if (!APPLY) {
    console.log('\n(dry run - nothing written. Pass --apply to make the changes.)')
    return
  }

  const backup = path.join(CONFIG_DIR, `config.backup-${Date.now()}.json`)
  fs.writeFileSync(backup, raw)
  console.log(`\nBacked up original to ${backup}`)

  const tmp = CONFIG + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2))
  fs.renameSync(tmp, CONFIG)
  console.log(`Wrote ${CONFIG}`)

  sideFiles.forEach(f => {
    try { fs.rmSync(f, { force: true }); console.log('Deleted ' + f) } catch (e) { console.log('Could not delete ' + f + ': ' + e.message) }
  })
  try {
    fs.rmSync(STREAMS, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    if (!fs.existsSync(STREAMS)) console.log('Deleted ' + STREAMS)
  } catch (e) { console.log('Could not delete ' + STREAMS + ': ' + e.message) }

  console.log('\nDone.')
}

main()
