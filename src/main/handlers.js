// Everything the app asks to open, and the name each is registered under.
// Windows wants the choice made against a ProgId, not against the protocol
// itself, which is how every other program registers one.
const ASSOCIATIONS = [
  { what: '.torrent', progId: 'com.streamtorrent.torrent', kind: 'torrentFiles' },
  { what: 'magnet', progId: 'com.streamtorrent.magnet', kind: 'magnetLinks' },
  { what: 'stream-magnet', progId: 'com.streamtorrent.stream-magnet', kind: 'magnetLinks' }
]

// Torrent files and magnet links are asked for separately, so everything here
// takes a pair of flags saying which of the two is being talked about. Left
// out means both, which is what every call that predates the split meant.
const BOTH = { torrentFiles: true, magnetLinks: true }

module.exports = {
  install,
  uninstall,
  isOverriddenWin32,
  takeAssociationsWin32,
  openDefaultAppsSettings,
  associationsFor,
  ASSOCIATIONS
}

// The things Windows would have to be told about for this choice
function associationsFor (which) {
  const want = which || BOTH
  return ASSOCIATIONS.filter(a => want[a.kind])
}

const config = require('../config')
const path = require('path')

// The app's own name in the registry, used both for the file type and for the
// entry Windows' own Default apps screen lists it under
const PROG_ID = 'com.streamtorrent.torrent'
const CAPABILITY_KEY = '\\Software\\StreamTorrent\\Capabilities'

function install (which) {
  switch (process.platform) {
    case 'darwin': installDarwin()
      break
    case 'win32': installWin32(which || BOTH)
      break
  }
}

function uninstall (which) {
  switch (process.platform) {
    case 'darwin': uninstallDarwin()
      return Promise.resolve()
    case 'win32': return uninstallWin32(which || BOTH)
  }
  return Promise.resolve()
}

function installDarwin () {
  const { app } = require('electron')

  // On Mac, only protocols that are listed in `Info.plist` can be set as the
  // default handler at runtime.
  app.setAsDefaultProtocolClient('magnet')
  app.setAsDefaultProtocolClient('stream-magnet')

  // File handlers are defined in `Info.plist`.
}

function uninstallDarwin () {}

const EXEC_COMMAND = [process.execPath, '--']

if (!config.IS_PRODUCTION) {
  EXEC_COMMAND.push(config.ROOT_PATH)
}

function installWin32 (which) {
  const Registry = require('winreg')

  const log = require('./log')

  const iconPath = path.join(
    process.resourcesPath, 'app.asar.unpacked', 'static',
    path.basename(config.APP_FILE_ICON) + '.ico'
  )

  if (which.magnetLinks) {
    registerProtocolHandlerWin32(
      'magnet',
      'URL:BitTorrent Magnet URL',
      iconPath,
      EXEC_COMMAND
    )
    registerProtocolHandlerWin32(
      'stream-magnet',
      'URL:BitTorrent Stream-Magnet URL',
      iconPath,
      EXEC_COMMAND
    )

    // The same two under names of our own. Windows records which program opens
    // a link by its ProgId, so a protocol needs one as well as the protocol key
    // itself, the way every other program registers one.
    registerProtocolHandlerWin32(
      progIdFor('magnet'),
      'URL:BitTorrent Magnet URL',
      iconPath,
      EXEC_COMMAND
    )
    registerProtocolHandlerWin32(
      progIdFor('stream-magnet'),
      'URL:BitTorrent Stream-Magnet URL',
      iconPath,
      EXEC_COMMAND
    )
  }

  if (which.torrentFiles) {
    registerFileHandlerWin32(
      '.torrent',
      PROG_ID,
      'BitTorrent Document',
      iconPath,
      EXEC_COMMAND
    )
    offerInOpenWithWin32('.torrent', PROG_ID)
  }

  registerCapabilitiesWin32(which)

  /**
   * To add a protocol handler, the following keys must be added to the Windows registry:
   *
   * HKEY_CLASSES_ROOT
   *   $PROTOCOL
   *     (Default) = "$NAME"
   *     URL Protocol = ""
   *     DefaultIcon
   *       (Default) = "$ICON"
   *     shell
   *       open
   *         command
   *           (Default) = "$COMMAND" "%1"
   *
   * Source: https://msdn.microsoft.com/en-us/library/aa767914.aspx
   *
   * However, the "HKEY_CLASSES_ROOT" key can only be written by the Administrator user.
   * So, we instead write to "HKEY_CURRENT_USER\Software\Classes", which is inherited by
   * "HKEY_CLASSES_ROOT" anyway, and can be written by unprivileged users.
   */

  function registerProtocolHandlerWin32 (protocol, name, icon, command) {
    const protocolKey = new Registry({
      hive: Registry.HKCU, // HKEY_CURRENT_USER
      key: '\\Software\\Classes\\' + protocol
    })

    setProtocol()

    function setProtocol (err) {
      if (err) return log.error(err.message)
      protocolKey.set('', Registry.REG_SZ, name, setURLProtocol)
    }

    function setURLProtocol (err) {
      if (err) return log.error(err.message)
      protocolKey.set('URL Protocol', Registry.REG_SZ, '', setIcon)
    }

    function setIcon (err) {
      if (err) return log.error(err.message)

      const iconKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${protocol}\\DefaultIcon`
      })
      iconKey.set('', Registry.REG_SZ, icon, setCommand)
    }

    function setCommand (err) {
      if (err) return log.error(err.message)

      const commandKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${protocol}\\shell\\open\\command`
      })
      commandKey.set('', Registry.REG_SZ, `${commandToArgs(command)} "%1"`, done)
    }

    function done (err) {
      if (err) return log.error(err.message)
    }
  }

  /**
   * To add a file handler, the following keys must be added to the Windows registry:
   *
   * HKEY_CLASSES_ROOT
   *   $EXTENSION
   *     (Default) = "$EXTENSION_ID"
   *   $EXTENSION_ID
   *     (Default) = "$NAME"
   *     DefaultIcon
   *       (Default) = "$ICON"
   *     shell
   *       open
   *         command
   *           (Default) = "$COMMAND" "%1"
   */
  function registerFileHandlerWin32 (ext, id, name, icon, command) {
    setExt()

    function setExt () {
      const extKey = new Registry({
        hive: Registry.HKCU, // HKEY_CURRENT_USER
        key: `\\Software\\Classes\\${ext}`
      })
      extKey.set('', Registry.REG_SZ, id, setId)
    }

    function setId (err) {
      if (err) return log.error(err.message)

      const idKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${id}`
      })
      idKey.set('', Registry.REG_SZ, name, setIcon)
    }

    function setIcon (err) {
      if (err) return log.error(err.message)

      const iconKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${id}\\DefaultIcon`
      })
      iconKey.set('', Registry.REG_SZ, icon, setCommand)
    }

    function setCommand (err) {
      if (err) return log.error(err.message)

      const commandKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${id}\\shell\\open\\command`
      })
      commandKey.set('', Registry.REG_SZ, `${commandToArgs(command)} "%1"`, done)
    }

    function done (err) {
      if (err) return log.error(err.message)
    }
  }

  /**
   * Puts the app in the "Open with" list for an extension. This is separate
   * from being the program that opens it: Windows keeps whichever program the
   * user has already chosen, and an entry here is how they can pick this one.
   */
  function offerInOpenWithWin32 (ext, id) {
    const key = new Registry({
      hive: Registry.HKCU,
      key: `\\Software\\Classes\\${ext}\\OpenWithProgids`
    })
    key.set(id, Registry.REG_SZ, '', (err) => {
      if (err) log.error(err.message)
    })
  }

  /**
   * What the app says it can open, so that it is listed in Windows' own
   * Default apps screen. Without this the user has no way of choosing it
   * there, however the file types themselves are registered.
   */
  function registerCapabilitiesWin32 (which) {
    const capabilities = new Registry({
      hive: Registry.HKCU,
      key: CAPABILITY_KEY
    })

    capabilities.set('ApplicationName', Registry.REG_SZ, config.APP_NAME, (err) => {
      if (err) return log.error(err.message)
      capabilities.set('ApplicationDescription', Registry.REG_SZ,
        'Streams video out of torrents', () => {})
    })

    // Only what was asked for is claimed here, so Windows' own Default apps
    // screen lists the app against those and nothing else
    if (which.torrentFiles) {
      const files = new Registry({
        hive: Registry.HKCU,
        key: CAPABILITY_KEY + '\\FileAssociations'
      })
      files.set('.torrent', Registry.REG_SZ, PROG_ID, (err) => {
        if (err) log.error(err.message)
      })
    }

    if (which.magnetLinks) {
      const urls = new Registry({
        hive: Registry.HKCU,
        key: CAPABILITY_KEY + '\\URLAssociations'
      })
      urls.set('magnet', Registry.REG_SZ, progIdFor('magnet'), (err) => {
        if (err) log.error(err.message)
      })
    }

    const registered = new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\RegisteredApplications'
    })
    registered.set(config.APP_NAME, Registry.REG_SZ,
      CAPABILITY_KEY.replace(/^\\/, ''), (err) => {
        if (err) log.error(err.message)
      })
  }
}

/**
 * Where Windows keeps the choice of which program opens something, for a
 * file extension and for a link protocol.
 */
function userChoiceKeyWin32 (what) {
  return 'HKCU\\' + require('./user-choice').keyPathFor(what)
}

// What Windows opens this extension or protocol with, as a ProgId, or null
// when nothing has been chosen
function chosenHandlerWin32 (what) {
  if (process.platform !== 'win32') return null

  try {
    const out = require('child_process').execFileSync(
      'reg.exe', ['query', userChoiceKeyWin32(what), '/v', 'ProgId'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const match = out.match(/ProgId\s+REG_SZ\s+(\S+)/)
    return match ? match[1] : null
  } catch (err) {
    return null // no such key
  }
}

// The name this extension or protocol is registered under
function progIdFor (what) {
  const entry = ASSOCIATIONS.find(a => a.what === what)
  return entry ? entry.progId : PROG_ID
}

/**
 * Whether something other than us has been chosen to open this.
 */
function isOverriddenWin32 (what) {
  const chosen = chosenHandlerWin32(what)
  return !!chosen && chosen !== progIdFor(what)
}

/**
 * Makes the app what Windows opens torrents and magnet links with.
 *
 * Registering under Software\Classes is not enough on its own: Windows keeps
 * the choice the user last made in a key of its own, and that choice wins.
 * See user-choice.js for what is in that key and why it can be written.
 *
 * Only ever called when the user asks for it. Returns the ones it could not
 * take, so the caller can fall back to asking Windows.
 */
async function takeAssociationsWin32 (which) {
  const wanted = associationsFor(which)
  if (process.platform !== 'win32') return wanted.map(a => a.what)

  const taken = await require('./user-choice').take(wanted)
  require('./log')('could not take: ' + (taken.join(', ') || 'nothing'))

  return taken
}

// Windows' own screen for choosing which program opens what
function openDefaultAppsSettings () {
  if (process.platform !== 'win32') return
  const { shell } = require('electron')
  shell.openExternal('ms-settings:defaultapps').catch(() => {})
}

async function uninstallWin32 (which) {
  const Registry = require('winreg')
  const dropping = which || BOTH

  // Hand back what Windows records as ours before the registrations go, or
  // the choice would point at a program that no longer claims anything
  try {
    await require('./user-choice').release(associationsFor(dropping))
  } catch (err) {
    require('./log').error('could not hand the associations back: ' + err.message)
  }

  if (dropping.magnetLinks) {
    unregisterProtocolHandlerWin32('magnet', EXEC_COMMAND)
    unregisterProtocolHandlerWin32('stream-magnet', EXEC_COMMAND)
    unregisterProtocolHandlerWin32(progIdFor('magnet'), EXEC_COMMAND)
    unregisterProtocolHandlerWin32(progIdFor('stream-magnet'), EXEC_COMMAND)
  }
  if (dropping.torrentFiles) {
    unregisterFileHandlerWin32('.torrent', PROG_ID, EXEC_COMMAND)
  }
  forgetCapabilitiesWin32(dropping)

  // The entries that only offer the app as a choice go too, so that nothing
  // is left listing it once it no longer opens anything. What the app is
  // still registered for stays: giving up magnet links does not take the
  // torrent files with it.
  function forgetCapabilitiesWin32 (dropping) {
    if (dropping.torrentFiles) {
      new Registry({
        hive: Registry.HKCU,
        key: '\\Software\\Classes\\.torrent\\OpenWithProgids'
      }).remove(PROG_ID, () => {})

      new Registry({
        hive: Registry.HKCU,
        key: CAPABILITY_KEY + '\\FileAssociations'
      }).remove('.torrent', () => {})
    }

    if (dropping.magnetLinks) {
      new Registry({
        hive: Registry.HKCU,
        key: CAPABILITY_KEY + '\\URLAssociations'
      }).remove('magnet', () => {})
    }

    if (!dropping.torrentFiles || !dropping.magnetLinks) return

    new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\RegisteredApplications'
    }).remove(config.APP_NAME, () => {})

    new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\StreamTorrent'
    }).destroy(() => {})
  }

  function unregisterProtocolHandlerWin32 (protocol, command) {
    getCommand()

    function getCommand () {
      const commandKey = new Registry({
        hive: Registry.HKCU, // HKEY_CURRENT_USER
        key: `\\Software\\Classes\\${protocol}\\shell\\open\\command`
      })
      commandKey.get('', (err, item) => {
        if (!err && item.value.indexOf(commandToArgs(command)) >= 0) {
          destroyProtocol()
        }
      })
    }

    function destroyProtocol () {
      const protocolKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${protocol}`
      })
      protocolKey.destroy(() => {})
    }
  }

  function unregisterFileHandlerWin32 (ext, id, command) {
    eraseId()

    function eraseId () {
      const idKey = new Registry({
        hive: Registry.HKCU, // HKEY_CURRENT_USER
        key: `\\Software\\Classes\\${id}`
      })
      idKey.destroy(getExt)
    }

    function getExt () {
      const extKey = new Registry({
        hive: Registry.HKCU,
        key: `\\Software\\Classes\\${ext}`
      })
      extKey.get('', (err, item) => {
        if (!err && item.value === id) {
          destroyExt()
        }
      })
    }

    function destroyExt () {
      const extKey = new Registry({
        hive: Registry.HKCU, // HKEY_CURRENT_USER
        key: `\\Software\\Classes\\${ext}`
      })
      extKey.destroy(() => {})
    }
  }
}

function commandToArgs (command) {
  return command.map((arg) => `"${arg}"`).join(' ')
}
