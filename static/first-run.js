/**
 * The window shown once, right after installing: which shortcuts to keep and
 * whether torrent files and magnet links should open in StreamTorrent.
 */

const { ipcRenderer } = require('electron')

const checked = id => document.getElementById(id).checked

document.getElementById('finish').addEventListener('click', () => {
  ipcRenderer.send('first-run-choice', {
    desktop: checked('desktop'),
    startMenu: checked('startMenu'),
    fileHandler: checked('fileHandler')
  })
})

// Enter finishes; Escape closes the window and leaves everything as it is
window.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('finish').click()
  if (e.key === 'Escape') window.close()
})
