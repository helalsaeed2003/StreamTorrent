/**
 * Making StreamTorrent the program Windows actually opens torrents with.
 *
 * Registering under Software\Classes is not enough. Windows keeps the choice
 * the user last made in its own key:
 *
 *   HKCU\...\Explorer\FileExts\<.ext>\UserChoice          (for a file type)
 *   HKCU\...\Shell\Associations\UrlAssociations\<proto>\UserChoice
 *
 * and that choice wins. The key holds the ProgId together with a Hash that
 * Windows checks: it is worked out from the extension, the user's SID, the
 * ProgId and the minute the key was last written, so a value copied from
 * somewhere else, or left behind by an older version, is thrown away. With no
 * key at all, Windows asks the user which program to use instead of falling
 * back to what is registered, which is why simply clearing it is not enough.
 *
 * The hash itself is not documented. What is here follows Mozilla's reading
 * of it in browser/components/shell/WindowsUserChoice.cpp, which Firefox uses
 * to make itself the default browser. It is the format Windows has used since
 * build 1703; on anything older, or on a Windows new enough to run the User
 * Choice Protection Driver, writing the key is refused and we say so rather
 * than pretending it worked.
 */

const crypto = require('crypto')
const { execFile } = require('child_process')

module.exports = {
  hashFor,
  keyPathFor,
  take,
  release,
  isProtected
}

// Part of the hash, built into Windows. There is no way of working it out,
// so if Microsoft ever changes it, the hashes stop being accepted.
const USER_EXPERIENCE =
  'User Choice set via Windows User Experience ' +
  '{D18B6DD5-6124-4341-9318-804003BAFA0B}'

// One minute, in the 100-nanosecond units a Windows FILETIME counts in. The
// seconds and milliseconds are left out of the hash, so everything below a
// whole minute is cut off.
const MINUTE = 600000000n

/**
 * Where Windows keeps the choice, under HKEY_CURRENT_USER. An extension is
 * told apart from a protocol by its leading dot, the way Windows does it.
 */
function keyPathFor (what) {
  if (what.startsWith('.')) {
    return 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\' +
      'FileExts\\' + what + '\\UserChoice'
  }
  return 'SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\' +
    'UrlAssociations\\' + what + '\\UserChoice'
}

/** Rotates the halves of a 32-bit word. */
function wordSwap (value) {
  return ((value >>> 16) | (value << 16)) >>> 0
}

/**
 * The hash Windows stores beside the ProgId.
 *
 * `fileTime` is when the key was last written, as a BigInt FILETIME. It is cut
 * down to the minute here, so the caller can pass the time as it is.
 */
function hashFor (what, userSid, progId, fileTime) {
  const whole = BigInt(fileTime) - (BigInt(fileTime) % MINUTE)
  const high = Number((whole >> 32n) & 0xffffffffn) >>> 0
  const low = Number(whole & 0xffffffffn) >>> 0

  const text = (
    what + userSid + progId +
    high.toString(16).padStart(8, '0') +
    low.toString(16).padStart(8, '0') +
    USER_EXPERIENCE
  ).toLowerCase()

  // Windows hashes the string as it holds it: two bytes a character, with the
  // end of the string counted in
  const bytes = Buffer.from(text + '\0', 'utf16le')

  // Anything past the last whole pair of 32-bit words is ignored
  const blocks = Math.floor(bytes.length / 8)
  if (blocks === 0) return null

  const md5 = crypto.createHash('md5').update(bytes).digest()
  const key0 = (md5.readUInt32LE(0) | 1) >>> 0
  const key1 = (md5.readUInt32LE(4) | 1) >>> 0

  const c0 = [
    [key0, 0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83],
    [key1, 0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69]
  ]
  const c1 = [
    [key0, 0xef0569fb, 0x689b6b9f, 0x79f8a395, 0xc3efea97],
    [key1, 0xc31713db, 0xddcd1f0f, 0x59c3af2d, 0x35bd1ec9]
  ]

  // Two running sums, stirred after every word, and the totals of each
  let h0 = 0
  let h1 = 0
  let h0Acc = 0
  let h1Acc = 0

  const mul = (a, b) => Math.imul(a, b) >>> 0

  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < 2; j++) {
      const a = c0[j]
      const b = c1[j]
      const word = bytes.readUInt32LE((i * 2 + j) * 4)

      h0 = (h0 + word) >>> 0
      h0 = mul(h0, a[0])
      h0 = mul(wordSwap(h0), a[1])
      h0 = mul(wordSwap(h0), a[2])
      h0 = mul(wordSwap(h0), a[3])
      h0 = mul(wordSwap(h0), a[4])
      h0Acc = (h0Acc + h0) >>> 0

      h1 = (h1 + word) >>> 0
      h1 = (mul(wordSwap(h1), b[1]) + mul(h1, b[0])) >>> 0
      h1 = (mul(h1 >>> 16, b[2]) + mul(h1, b[3])) >>> 0
      h1 = (mul(wordSwap(h1), b[4]) + h1) >>> 0
      h1Acc = (h1Acc + h1) >>> 0
    }
  }

  const out = Buffer.alloc(8)
  out.writeUInt32LE((h0 ^ h1) >>> 0, 0)
  out.writeUInt32LE((h0Acc ^ h1Acc) >>> 0, 4)

  return out.toString('base64')
}

/**
 * Windows 10 builds from February 2024 carry a driver that refuses writes to
 * these keys outright. Where it is running, none of this works.
 */
async function isProtected () {
  if (process.platform !== 'win32') return true
  try {
    const out = await run([
      '$s = Get-Service UCPD -ErrorAction SilentlyContinue',
      'if ($s -and $s.Status -eq "Running") { "yes" } else { "no" }'
    ].join('\n'))
    return out.trim() === 'yes'
  } catch (err) {
    return false
  }
}

// Each of these starts a PowerShell, which takes a few tenths of a second.
// Waiting for it would stop the whole app: the window would not redraw and
// nothing on it would answer until every one of them had finished.
function run (script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      }
    )
  })
}

// Reading a registry key's last-write time, and writing a key the user has
// been denied write access to, are both beyond what Node can do on its own
const HELPERS = [
  'Add-Type -Namespace StreamTorrent -Name Reg -MemberDefinition @"',
  '[DllImport("advapi32.dll", CharSet = CharSet.Unicode)]',
  'public static extern int RegQueryInfoKeyW(IntPtr key, System.Text.StringBuilder cls,',
  '  ref uint clsLen, IntPtr reserved, out uint subKeys, out uint maxSubKeyLen,',
  '  out uint maxClassLen, out uint values, out uint maxValueNameLen,',
  '  out uint maxValueLen, out uint securityDescriptor, out long lastWrite);',
  '[DllImport("shell32.dll")]',
  'public static extern void SHChangeNotify(int eventId, uint flags, IntPtr a, IntPtr b);',
  '"@',
  '',
  'function Get-LastWrite($key) {',
  '  $cls = New-Object System.Text.StringBuilder 0',
  '  $clsLen = [uint32]0',
  '  $a = 0; $b = 0; $c = 0; $d = 0; $e = 0; $f = 0; $g = 0; $t = [long]0',
  '  $rc = [StreamTorrent.Reg]::RegQueryInfoKeyW($key.Handle.DangerousGetHandle(),',
  '    $cls, [ref]$clsLen, [IntPtr]::Zero, [ref]$a, [ref]$b, [ref]$c, [ref]$d,',
  '    [ref]$e, [ref]$f, [ref]$g, [ref]$t)',
  '  if ($rc -ne 0) { return [long]0 }',
  '  return $t',
  '}',
  '',
  'function Clear-Deny($path) {',
  '  try {',
  '    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path,',
  '      [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,',
  '      [System.Security.AccessControl.RegistryRights]::ChangePermissions)',
  '    if ($null -eq $k) { return }',
  '    $acl = $k.GetAccessControl()',
  '    foreach ($r in @($acl.Access | Where-Object { $_.AccessControlType -eq "Deny" })) {',
  '      $acl.RemoveAccessRuleSpecific($r) | Out-Null',
  '    }',
  '    $k.SetAccessControl($acl)',
  '    $k.Close()',
  '  } catch {}',
  '}',
  '',
  'function Remove-Key($path) {',
  '  try {',
  '    $parent = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey((Split-Path $path -Parent), $true)',
  '    if ($parent) { $parent.DeleteSubKeyTree((Split-Path $path -Leaf), $false); $parent.Close() }',
  '  } catch {}',
  '}'
].join('\n')

/**
 * Starts a fresh, writable UserChoice key and says when it was made, so the
 * hash can be worked out for that minute.
 */
async function prepare (keyPath) {
  const out = await run([
    HELPERS,
    '$ErrorActionPreference = "SilentlyContinue"',
    '$path = ' + quote(keyPath),
    'Clear-Deny $path',
    'Remove-Key $path',
    '$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)',
    '$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '$t = Get-LastWrite $k',
    '$k.Close()',
    '"$sid|$t"'
  ].join('\n'))

  const [sid, fileTime] = out.trim().split('|')
  if (!sid || !fileTime) throw new Error('could not start the key')

  return { sid, fileTime: BigInt(fileTime) }
}

/**
 * Writes the choice, and says when Windows recorded the key as last written,
 * which has to land in the same minute the hash was worked out for.
 */
async function commit (keyPath, progId, hash) {
  const out = await run([
    HELPERS,
    '$ErrorActionPreference = "SilentlyContinue"',
    '$path = ' + quote(keyPath),
    '$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path, $true)',
    'if ($null -eq $k) { "0"; exit }',
    '$k.SetValue("ProgId", ' + quote(progId) + ', [Microsoft.Win32.RegistryValueKind]::String)',
    '$k.SetValue("Hash", ' + quote(hash) + ', [Microsoft.Win32.RegistryValueKind]::String)',
    '$t = Get-LastWrite $k',
    '$k.Close()',
    '"$t"'
  ].join('\n'))

  return BigInt(out.trim() || '0')
}

/** Tells Explorer to stop using the associations it had cached. */
async function announce () {
  try {
    await run([
      HELPERS,
      // SHCNE_ASSOCCHANGED, SHCNF_IDLIST
      '[StreamTorrent.Reg]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)'
    ].join('\n'))
  } catch (err) {}
}

function quote (text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

// The app's own log, when there is one. This module is also run on its own,
// outside Electron, to check the hash against what Windows expects.
function warn (message) {
  try {
    require('./log').error(message)
  } catch (err) {
    console.error(message)
  }
}

/**
 * Makes `progId` the program Windows opens `what` with, where `what` is an
 * extension like '.torrent' or a protocol like 'magnet'.
 *
 * The hash covers the minute the key was last written, and writing the values
 * is itself a write, so the two can fall either side of a minute boundary. It
 * is tried again when that happens.
 *
 * Returns true once the key holds a hash that matches what Windows will work
 * out for itself.
 */
async function takeOne (what, progId, attempts = 3) {
  const keyPath = keyPathFor(what)

  for (let i = 0; i < attempts; i++) {
    const { sid, fileTime } = await prepare(keyPath)
    const hash = hashFor(what, sid, progId, fileTime)
    if (!hash) return false

    const written = await commit(keyPath, progId, hash)
    if (written === 0n) return false

    // The hash only covers whole minutes, so the write may land in the same
    // one even though the exact times differ
    if (written - (written % MINUTE) === fileTime - (fileTime % MINUTE)) {
      return true
    }
  }

  return false
}

/**
 * Gives back anything we hold, for when the user turns this off. Only the
 * entries naming us are removed, so a choice they have since made for another
 * program is left alone. Windows then asks the next time, which is the right
 * thing: we are no longer claiming it.
 */
async function release (items) {
  if (process.platform !== 'win32') return

  let gaveBack = false

  for (const { what, progId } of items) {
    const keyPath = keyPathFor(what)
    let held = false
    try {
      held = (await run([
        HELPERS,
        '$ErrorActionPreference = "SilentlyContinue"',
        '$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(' + quote(keyPath) + ', $false)',
        'if ($null -eq $k) { "no" } else {',
        '  $p = $k.GetValue("ProgId"); $k.Close()',
        '  if ($p -eq ' + quote(progId) + ') { "yes" } else { "no" }',
        '}'
      ].join('\n'))).trim() === 'yes'
    } catch (err) {
      warn('could not look at what opens ' + what + ': ' + err.message)
    }

    if (!held) continue

    try {
      await run([
        HELPERS,
        '$ErrorActionPreference = "SilentlyContinue"',
        '$path = ' + quote(keyPath),
        'Clear-Deny $path',
        'Remove-Key $path'
      ].join('\n'))
      gaveBack = true
    } catch (err) {
      warn('could not give back ' + what + ': ' + err.message)
    }
  }

  if (gaveBack) await announce()
}

/**
 * Takes over a list of extensions and protocols. Returns the ones it could
 * not take, so the caller can fall back to asking Windows.
 */
async function take (items) {
  if (process.platform !== 'win32') return items.slice()
  if (await isProtected()) return items.slice()

  const failed = []
  for (const { what, progId } of items) {
    let ok = false
    try {
      ok = await takeOne(what, progId)
    } catch (err) {
      warn('could not take ' + what + ': ' + err.message)
    }
    if (!ok) failed.push(what)
  }

  if (failed.length < items.length) await announce()

  return failed
}
