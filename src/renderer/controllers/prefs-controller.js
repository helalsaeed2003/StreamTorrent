const { dispatch } = require('../lib/dispatcher')
const { ipcRenderer } = require('electron')

const tempPath = require('../../temp-path')

// Controls the Preferences screen
module.exports = class PrefsController {
  constructor (state, config) {
    this.state = state
    this.config = config
  }

  // Goes to the Preferences screen
  show () {
    const state = this.state
    this.refreshTempUsage()
    state.location.go({
      url: 'preferences',
      setup (cb) {
        // initialize preferences
        state.window.title = 'Preferences'
        ipcRenderer.send('setAllowNav', false)
        cb()
      },
      destroy: () => {
        ipcRenderer.send('setAllowNav', true)
      }
    })
  }

  // Updates a single property in the saved prefs
  // For example: updatePreferences('isFileHandler', true)
  update (property, value) {
    if (property === 'isFileHandler') ipcRenderer.send('setDefaultFileHandler', value)
    else if (property === 'startup') ipcRenderer.send('setStartup', value)
    else if (property === 'tempPath') return this.setTempFolder(value)

    this.state.saved.prefs[property] = value
    dispatch('stateSaveImmediate')
  }

  /**
   * Points the temp folder somewhere else. The new location is used from the
   * next video played; what is already downloaded stays where it is until the
   * old folder is cleared, which happens on quit and on the next start.
   */
  setTempFolder (folder) {
    const state = this.state
    const previous = state.tempPath

    state.saved.prefs.tempPath = folder || ''

    const result = this.applyTempPath()

    if (result.usedFallback) {
      dispatch('error',
        `Can't use ${result.wanted} for temporary files (${result.error}). ` +
        'Falling back to the default folder.')
      // Don't keep a setting that does not work
      state.saved.prefs.tempPath = ''
    }

    // Remember the folder we were using, so it gets cleared later even though
    // files in it may be open right now
    if (previous && previous !== state.tempPath) {
      if (!state.saved.staleTempPaths.includes(previous)) {
        state.saved.staleTempPaths.push(previous)
      }
    }

    dispatch('stateSaveImmediate')
    this.refreshTempUsage()
    return result
  }

  resetTempFolder () {
    return this.setTempFolder('')
  }

  /**
   * Works out which temp folder to use, makes sure it is usable, and tells the
   * rest of the app. Called at startup and whenever the setting changes.
   */
  applyTempPath () {
    const state = this.state
    const result = tempPath.prepare(state.saved.prefs)

    state.tempPath = result.path
    console.log('temporary files go in %s%s', result.path,
      result.usedFallback ? ' (fell back from ' + result.wanted + ')' : '')

    // The WebTorrent process needs it to know what it is allowed to delete,
    // and the main process to clear it on quit
    ipcRenderer.send('wt-set-temp-path', result.path)
    ipcRenderer.send('setTempPath', result.path, state.saved.staleTempPaths)

    return result
  }

  // How much space the temp folder is using, for the Preferences screen
  refreshTempUsage () {
    const state = this.state
    const folder = state.tempPath || tempPath.resolve(state.saved.prefs)
    state.tempUsage = { path: folder, bytes: tempPath.getSize(folder) }
    return state.tempUsage
  }

  /**
   * "Clear now": throw away everything downloaded so far, including folders
   * left behind by an earlier choice of location. Anything playing right now is
   * stopped first so its files are not locked.
   */
  clearTempNow () {
    const state = this.state

    if (state.location.url() === 'player') dispatch('backToList')
    else if (state.streaming) dispatch('stopDownloading')

    ipcRenderer.send('wt-clear-temp')

    // Give the WebTorrent process a moment to close its files, then report
    setTimeout(() => {
      this.refreshTempUsage()
      dispatch('update')
    }, 1500)
  }
}
