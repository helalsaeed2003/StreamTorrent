/**
 * Runs the bundled mpv as the video engine.
 *
 * mpv draws straight into a window we hand it (see windows/video.js), so the
 * video appears inside StreamTorrent rather than in a player of its own, and
 * everything else - play, pause, seek, volume, speed, audio tracks, subtitles -
 * is driven over mpv's JSON IPC on a named pipe.
 *
 * Using mpv means every format plays as-is: HEVC in .mkv, EAC3/DTS audio, .avi,
 * .wmv, and embedded ASS/SRT subtitles, with no conversion and no second app to
 * install.
 */

module.exports = {
  start,
  load,
  command,
  setProperty,
  stop,
  isRunning
}

const cp = require('child_process')
const fs = require('fs')
const net = require('net')
const path = require('path')

const config = require('../config')
const log = require('./log')
const windows = require('./windows')

// Properties we want to hear about as they change. The ids are how mpv tags
// the change events it sends back.
const OBSERVED = [
  [1, 'time-pos'],
  [2, 'duration'],
  [3, 'pause'],
  [4, 'eof-reached'],
  [5, 'track-list'],
  [6, 'sid'],
  [7, 'aid'],
  [8, 'volume'],
  [9, 'speed'],
  [10, 'sub-delay'],
  [11, 'sub-scale'],
  [12, 'paused-for-cache'],
  [13, 'demuxer-cache-time'],
  [14, 'width'],
  [15, 'height'],
  [16, 'seeking']
]

let proc = null
let sock = null
let nextRequestId = 100
const pending = new Map()
let buffer = ''
let pipeName = null
let starting = null

function isRunning () {
  return !!proc && !!sock
}

/**
 * Starts mpv, attached to the given native window handle, and connects to its
 * IPC pipe. Resolves once mpv is answering commands.
 */
function start ({ wid }) {
  if (starting) return starting
  if (isRunning()) return Promise.resolve()

  pipeName = '\\\\.\\pipe\\streamtorrent-mpv-' + process.pid

  // mpv reads its settings from a folder of our own, so whatever mpv config the
  // user happens to have on their machine is ignored entirely
  const configDir = path.join(config.CONFIG_PATH, 'mpv')
  try {
    fs.mkdirSync(configDir, { recursive: true })
  } catch (err) {
    log('mpv: could not create config dir', err.message)
  }

  const args = [
    // Draw inside the window we were given, rather than opening one
    '--wid=' + wid,
    '--input-ipc-server=' + pipeName,
    '--config-dir=' + configDir,

    // Sit and wait for us to tell it what to play
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',

    // We draw our own controls, so mpv shows none of its own
    '--no-osc',
    '--osd-level=0',
    '--cursor-autohide=no',

    // mpv handles no mouse input: it cannot while it is drawing into a window
    // we gave it. The video window passes the mouse through to the page
    // instead - see windows/video.js.
    '--no-input-cursor',

    // Keyboard stays with the app, so the app's own hotkeys keep working
    '--input-vo-keyboard=no',
    '--input-default-bindings=no',

    // Streaming from the torrent-to-HTTP server: keep a healthy buffer and
    // never give up on a slow start
    '--cache=yes',
    '--demuxer-max-bytes=256MiB',
    '--demuxer-readahead-secs=30',
    '--network-timeout=60',
    '--hwdec=auto-safe',
    '--volume-max=130',

    // Subtitles the user is likely to want, picked automatically
    '--sub-auto=fuzzy',
    '--subs-fallback=default'
  ]

  log('mpv: starting', config.MPV_PATH)
  proc = cp.spawn(config.MPV_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] })

  proc.on('error', err => {
    log('mpv: failed to start', err.message)
    send('mpv-error', 'Could not start the video engine: ' + err.message)
    cleanup()
  })
  proc.stdout.on('data', d => log('mpv:', d.toString().trim()))
  proc.stderr.on('data', d => log('mpv:', d.toString().trim()))
  proc.on('exit', code => {
    log('mpv: exited with', code)
    cleanup()
  })

  starting = connect()
    .then(() => {
      starting = null
      OBSERVED.forEach(([id, name]) => command(['observe_property', id, name]))
    })
    .catch(err => {
      starting = null
      log('mpv: could not connect to its pipe', err.message)
      send('mpv-error', 'Could not talk to the video engine: ' + err.message)
      throw err
    })

  return starting
}

// mpv creates the pipe a moment after it starts, so retry briefly
function connect (attempt = 0) {
  return new Promise((resolve, reject) => {
    const client = net.connect(pipeName)

    client.on('connect', () => {
      sock = client
      buffer = ''
      log('mpv: connected')
      resolve()
    })

    client.on('data', onData)

    client.on('error', err => {
      client.destroy()
      if (attempt >= 40) return reject(err)
      setTimeout(() => connect(attempt + 1).then(resolve, reject), 100)
    })

    client.on('close', () => {
      if (sock === client) sock = null
    })
  })
}

function onData (chunk) {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch (err) {
      continue
    }

    if (message.request_id && pending.has(message.request_id)) {
      const resolve = pending.get(message.request_id)
      pending.delete(message.request_id)
      resolve(message.error === 'success' ? message.data : undefined)
      continue
    }

    if (message.event === 'property-change') {
      send('mpv-property', message.name, message.data)
    } else if (message.event) {
      send('mpv-event', message.event, message)
    }
  }
}

// Sends a command. Resolves with the reply, when there is one.
function command (args) {
  if (!sock) return Promise.resolve(undefined)

  const requestId = nextRequestId++
  return new Promise(resolve => {
    pending.set(requestId, resolve)
    try {
      sock.write(JSON.stringify({ command: args, request_id: requestId }) + '\n')
    } catch (err) {
      pending.delete(requestId)
      log('mpv: write failed', err.message)
      resolve(undefined)
    }
    // Never leave a caller hanging on a command mpv ignores
    setTimeout(() => {
      if (pending.has(requestId)) {
        pending.delete(requestId)
        resolve(undefined)
      }
    }, 5000)
  })
}

function setProperty (name, value) {
  return command(['set_property', name, value])
}

// Plays a URL. Options are mpv properties applied with the file.
function load (url, options = {}) {
  const pairs = Object.keys(options)
    .filter(key => options[key] !== undefined && options[key] !== null)
    .map(key => `${key}=${options[key]}`)
    .join(',')

  return command(pairs
    ? ['loadfile', url, 'replace', 0, pairs]
    : ['loadfile', url, 'replace'])
}

/**
 * Shuts mpv down and waits for the process to be gone.
 *
 * Playback has to be fully stopped before the temp folder can be cleared, or
 * Windows will refuse to delete the file mpv still has open.
 */
function stop () {
  return new Promise(resolve => {
    if (!proc) {
      cleanup()
      return resolve()
    }

    const child = proc
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    child.once('exit', done)

    // Ask nicely first, so mpv closes its files properly
    command(['quit']).catch(() => {})

    setTimeout(() => {
      if (settled) return
      log('mpv: did not quit in time, killing it')
      try {
        child.kill()
      } catch (err) {}
      setTimeout(done, 500)
    }, 2000)
  })
}

function cleanup () {
  if (sock) {
    try {
      sock.destroy()
    } catch (err) {}
  }
  sock = null
  proc = null
  pending.clear()
  buffer = ''
}

function send (channel, ...args) {
  try {
    windows.main.send(channel, ...args)
  } catch (err) {}
}
