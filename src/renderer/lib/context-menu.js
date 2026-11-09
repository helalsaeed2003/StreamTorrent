/**
 * Right-click menus.
 *
 * The menu itself is built and shown by the main process. One popped up from
 * the page is closed again by the very click that asked for it, and can even
 * pick its first item on the way, which is why menus are not built here.
 *
 * An item is a plain object, so it can be sent over IPC:
 *
 *   { label, action, args, enabled, type }
 *
 * "action" names an entry in the dispatcher, and "args" are passed to it when
 * the item is chosen. Falsy items are dropped, so a menu can be written with
 * conditions in it.
 */

const { ipcRenderer } = require('electron')

module.exports = { showContextMenu }

function showContextMenu (items) {
  ipcRenderer.send('show-context-menu', items.filter(Boolean))
}
