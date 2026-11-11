/**
 * Things that go into a build without ever being used, and are left out.
 *
 * Two kinds. Files inside the app itself, which are kept out by a pattern the
 * packager matches while it copies; and files belonging to Electron, which are
 * already there by the time the app is copied in and have to be deleted.
 *
 * Everything here has been checked to be dead weight rather than merely
 * unused-looking: see the notes on each.
 */

const fs = require('fs')
const path = require('path')

// The one language Chromium's own menus and dialogs are kept in. Anything
// else falls back to this one, and none of StreamTorrent is translated.
const LANGUAGE_KEPT = 'en-US.pak'

module.exports = {
  UNUSED_IN_APP,
  LANGUAGE_KEPT,
  removeOtherLanguages
}

/**
 * Parts of the installed packages nothing ever loads.
 *
 *   @types          TypeScript declarations. Nothing requires a .d.ts.
 *   dist, umd,      Single-file builds of libraries meant for a <script> tag.
 *   client,         Every one of these packages names index.js as its entry
 *   chromeapp       point, and the app loads them through that, so these are
 *                   second copies of code already in the build.
 *   prebuilds       Compiled binaries for platforms this build is not for.
 *                   node-gyp-build picks the folder matching the platform and
 *                   architecture it is running on.
 */
function UNUSED_IN_APP () {
  return new RegExp([
    '/node_modules/@types/',
    '/node_modules/protobufjs/dist/',
    '/node_modules/react-dom/umd/',
    '/node_modules/core-js/client/',
    '/node_modules/webtorrent/webtorrent\\.chromeapp\\.js$',
    '/prebuilds/(darwin|linux|android|win32-ia32|win32-arm64)'
  ].join('|'))
}

/**
 * Deletes the language files Electron ships for Chromium's own interface,
 * apart from the one kept. There are 55 of them and they come to 34 MB.
 *
 * Returns how many bytes went.
 */
function removeOtherLanguages (buildPath, log = () => {}) {
  const dir = path.join(buildPath, 'locales')

  let entries
  try {
    entries = fs.readdirSync(dir)
  } catch (err) {
    return 0
  }

  let freed = 0
  for (const name of entries) {
    if (name === LANGUAGE_KEPT) continue
    if (!name.endsWith('.pak')) continue

    const file = path.join(dir, name)
    try {
      freed += fs.statSync(file).size
      fs.unlinkSync(file)
    } catch (err) {
      log('could not remove ' + file + ': ' + err.message)
    }
  }

  log('left out ' + (freed / 1048576).toFixed(1) + ' MB of languages, kept ' +
    LANGUAGE_KEPT)

  return freed
}
