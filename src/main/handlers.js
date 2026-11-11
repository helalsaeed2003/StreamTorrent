module.exports = {
  install,
  uninstall,
  isOverriddenWin32,
  openDefaultAppsSettings
}

const config = require('../config')
const path = require('path')

// The app's own name in the registry, used both for the file type and for the
// entry Windows' own Default apps screen lists it under
const PROG_ID = 'com.streamtorrent.torrent'
const CAPABILITY_KEY = '\\Software\\StreamTorrent\\Capabilities'

function install () {
  switch (process.platform) {
    case 'darwin': installDarwin()
      break
    case 'win32': installWin32()
      break
  }
}

function uninstall () {
  switch (process.platform) {
    case 'darwin': uninstallDarwin()
      break
    case 'win32': uninstallWin32()
      break
  }
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

function installWin32 () {
  const Registry = require('winreg')

  const log = require('./log')

  const iconPath = path.join(
    process.resourcesPath, 'app.asar.unpacked', 'static',
    path.basename(config.APP_FILE_ICON) + '.ico'
  )
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
  registerFileHandlerWin32(
    '.torrent',
    PROG_ID,
    'BitTorrent Document',
    iconPath,
    EXEC_COMMAND
  )
  offerInOpenWithWin32('.torrent', PROG_ID)
  registerCapabilitiesWin32()

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
  function registerCapabilitiesWin32 () {
    const capabilities = new Registry({
      hive: Registry.HKCU,
      key: CAPABILITY_KEY
    })

    capabilities.set('ApplicationName', Registry.REG_SZ, config.APP_NAME, (err) => {
      if (err) return log.error(err.message)
      capabilities.set('ApplicationDescription', Registry.REG_SZ,
        'Streams video out of torrents', () => {})
    })

    const files = new Registry({
      hive: Registry.HKCU,
      key: CAPABILITY_KEY + '\\FileAssociations'
    })
    files.set('.torrent', Registry.REG_SZ, PROG_ID, (err) => {
      if (err) log.error(err.message)
    })

    const urls = new Registry({
      hive: Registry.HKCU,
      key: CAPABILITY_KEY + '\\URLAssociations'
    })
    urls.set('magnet', Registry.REG_SZ, 'magnet', (err) => {
      if (err) log.error(err.message)
    })

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
 * Whether Windows has already been told, by the user, which program opens this
 * extension. That choice overrides anything a program registers for itself,
 * and only the user can change it.
 */
function isOverriddenWin32 (ext) {
  if (process.platform !== 'win32') return false

  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\' +
    'FileExts\\' + ext + '\\UserChoice'

  try {
    const out = require('child_process').execFileSync(
      'reg.exe', ['query', key, '/v', 'ProgId'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const match = out.match(/ProgId\s+REG_SZ\s+(\S+)/)
    return !!match && match[1] !== PROG_ID
  } catch (err) {
    // No such key: nothing has been chosen, so what we registered stands
    return false
  }
}

// Windows' own screen for choosing which program opens what
function openDefaultAppsSettings () {
  if (process.platform !== 'win32') return
  const { shell } = require('electron')
  shell.openExternal('ms-settings:defaultapps').catch(() => {})
}

function uninstallWin32 () {
  const Registry = require('winreg')

  unregisterProtocolHandlerWin32('magnet', EXEC_COMMAND)
  unregisterProtocolHandlerWin32('stream-magnet', EXEC_COMMAND)
  unregisterFileHandlerWin32('.torrent', PROG_ID, EXEC_COMMAND)
  forgetCapabilitiesWin32()

  // The entries that only offer the app as a choice go too, so that nothing
  // is left listing it once it no longer opens anything
  function forgetCapabilitiesWin32 () {
    new Registry({
      hive: Registry.HKCU,
      key: '\\Software\\Classes\\.torrent\\OpenWithProgids'
    }).remove(PROG_ID, () => {})

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
