// Everything the app asks to open: the file type and the two link protocols
const ASSOCIATIONS = ['.torrent', 'magnet', 'stream-magnet']

module.exports = {
  install,
  uninstall,
  isOverriddenWin32,
  clearChosenHandlersWin32,
  openDefaultAppsSettings,
  ASSOCIATIONS
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
/**
 * Where Windows keeps the choice the user made in the "Open with" dialog, for
 * a file extension and for a link protocol. These win over anything a program
 * registers for itself, which is the whole point of them.
 */
function userChoiceKeyWin32 (what) {
  if (what.startsWith('.')) {
    return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\' +
      'FileExts\\' + what + '\\UserChoice'
  }
  return 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\' +
    'UrlAssociations\\' + what + '\\UserChoice'
}

// What Windows currently opens this extension or protocol with, as a ProgId,
// or null when nothing has been chosen and our own registration stands
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

/**
 * Whether something other than us has been chosen to open this.
 */
function isOverriddenWin32 (what) {
  const chosen = chosenHandlerWin32(what)
  return !!chosen && chosen !== PROG_ID && chosen !== 'magnet' &&
    chosen !== 'stream-magnet'
}

/**
 * Clears the choice, so that what we registered is used again.
 *
 * Windows will not let a program name itself in that key. The ProgId there is
 * signed by a hash only Explorer can work out, and the key carries an entry
 * denying the user themselves the right to write values into it. That is why
 * ticking the box used to appear to do nothing: everything was registered
 * correctly and then quietly ignored.
 *
 * The key can be cleared, though. The deny only covers writing values, while
 * the user still owns the key, so the deny can be taken off and the key then
 * removed. With nothing chosen, Windows falls back to the handler registered
 * under Software\Classes, which is ours. The user can choose something else
 * again whenever they like, in the Open with dialog or in Settings.
 *
 * Only ever called when the user asks for it.
 *
 * Returns the ones it could not clear.
 */
function clearChosenHandlersWin32 (things) {
  if (process.platform !== 'win32') return things.slice()

  const log = require('./log')

  const wanted = things.filter(what => chosenHandlerWin32(what))
  if (wanted.length === 0) return []

  // Node cannot change who may write to a registry key, so this one part is
  // done by Windows itself. Explorer is told afterwards, in the same run,
  // because it goes on using what it had cached otherwise.
  const paths = wanted
    .map(what => userChoiceKeyWin32(what).replace(/^HKCU\\/, ''))
    .map(path => "'" + path.replace(/'/g, "''") + "'")

  const script = [
    '$ErrorActionPreference = ' + "'SilentlyContinue'",
    '$paths = @(' + paths.join(',') + ')',
    'foreach ($p in $paths) {',
    '  try {',
    '    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($p,',
    '      [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,',
    '      [System.Security.AccessControl.RegistryRights]::ChangePermissions)',
    '    if ($k) {',
    '      $acl = $k.GetAccessControl()',
    '      foreach ($r in @($acl.Access | Where-Object {',
    "        $_.AccessControlType -eq 'Deny' })) {",
    '        $acl.RemoveAccessRuleSpecific($r) | Out-Null',
    '      }',
    '      $k.SetAccessControl($acl)',
    '      $k.Close()',
    '    }',
    '  } catch {}',
    '  try {',
    '    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(',
    '      (Split-Path $p -Parent), $true)',
    '    if ($parent) {',
    '      $parent.DeleteSubKeyTree((Split-Path $p -Leaf), $false)',
    '      $parent.Close()',
    '    }',
    '  } catch {}',
    '}',
    // SHCNE_ASSOCCHANGED, SHCNF_IDLIST
    'Add-Type -Namespace StreamTorrent -Name Shell -MemberDefinition ' +
      '\'[DllImport("shell32.dll")] public static extern void ' +
      'SHChangeNotify(int eventId, uint flags, IntPtr a, IntPtr b);\'',
    '[StreamTorrent.Shell]::SHChangeNotify(0x08000000, 0, ' +
      '[IntPtr]::Zero, [IntPtr]::Zero)'
  ].join('\n')

  try {
    require('child_process').execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: 'ignore', timeout: 30000 }
    )
  } catch (err) {
    log.error('could not clear what opens torrents: ' + err.message)
  }

  // Trust what is in the registry now, not what the script said
  const left = wanted.filter(what => chosenHandlerWin32(what))
  log('cleared: ' + (wanted.filter(w => !left.includes(w)).join(', ') || 'nothing'))

  return left
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
