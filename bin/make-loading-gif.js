#!/usr/bin/env node

/**
 * Draws the picture the Windows installer shows while it unpacks the app, and
 * writes it to static/loading.gif.
 *
 * The one that came with WebTorrent Desktop said "WebTorrent is installing...",
 * which is the wrong name now, so this draws our own. The page is rendered by
 * Electron and the picture is turned into a GIF by the bundled mpv, so there is
 * no image library to install:
 *
 *   node_modules/electron/dist/electron.exe bin/make-loading-gif.js
 *
 * It is a still picture, like the one it replaces: the installer only shows it
 * for a few seconds.
 */

const { app, BrowserWindow } = require('electron')
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT_PATH = path.join(__dirname, '..')
const STATIC_PATH = path.join(ROOT_PATH, 'static')
const MPV_PATH = path.join(ROOT_PATH, 'vendor', 'mpv', 'mpv.exe')
const OUT_PATH = path.join(STATIC_PATH, 'loading.gif')

// The size the old picture was, which is what the installer window expects
const SIZE = 400

function buildHtml () {
  const icon = fs.readFileSync(path.join(STATIC_PATH, 'StreamTorrent.png'))
  const iconURI = 'data:image/png;base64,' + icon.toString('base64')

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body {
        margin: 0;
        width: ${SIZE}px;
        height: ${SIZE}px;
        background: #2b2e33;
        color: #eceff4;
        font-family: Segoe UI, Helvetica Neue, sans-serif;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
      }
      img { width: 168px; height: 168px; }
      p { margin: 0; font-size: 19px; line-height: 1.5; text-align: center; }
      .quiet { color: #a8b0bd; font-size: 16px; }
    </style>
  </head>
  <body>
    <img src="${iconURI}">
    <p style="margin-top: 28px">StreamTorrent is installing...</p>
    <p class="quiet">It will launch once it is done.</p>
  </body>
</html>`
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#2b2e33'
  })

  await win.loadURL('data:text/html;charset=utf-8,' +
    encodeURIComponent(buildHtml()))

  // Give the font and the image a moment to be drawn
  await new Promise(resolve => setTimeout(resolve, 500))

  const image = await win.webContents.capturePage()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamtorrent-loading-'))
  const pngPath = path.join(dir, 'loading.png')
  fs.writeFileSync(pngPath, image.toPNG())

  // mpv carries FFmpeg's GIF encoder, so it can do the conversion for us
  const code = await new Promise(resolve => {
    const child = spawn(MPV_PATH, [
      '--no-config',
      '--no-terminal',
      '--msg-level=all=error',
      '--frames=1',
      // A GIF holds 256 colours. Left to itself the conversion dithers the
      // flat background into visible speckle, so the palette is built from the
      // picture first and used without dithering.
      '--vf=lavfi=[split[a][b];[a]palettegen=stats_mode=single[p];[b][p]paletteuse=dither=none]',
      '--o=' + OUT_PATH,
      pngPath
    ], { windowsHide: true, stdio: 'inherit' })
    child.on('exit', resolve)
    child.on('error', () => resolve(-1))
  })

  fs.rmSync(dir, { recursive: true, force: true })

  if (code !== 0 || !fs.existsSync(OUT_PATH)) {
    console.error('could not write ' + OUT_PATH + ' (mpv exited ' + code + ')')
    app.exit(1)
    return
  }

  console.log('wrote ' + OUT_PATH + ' (' + fs.statSync(OUT_PATH).size + ' bytes)')
  app.quit()
})
