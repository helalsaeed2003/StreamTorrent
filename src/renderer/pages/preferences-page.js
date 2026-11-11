const React = require('react')
const PropTypes = require('prop-types')

const colors = require('material-ui/styles/colors')
const Checkbox = require('material-ui/Checkbox').default
const RaisedButton = require('material-ui/RaisedButton').default
const TextField = require('material-ui/TextField').default
const Heading = require('../components/heading')
const PathSelector = require('../components/path-selector')

const prettyBytes = require('prettier-bytes')

const { dispatch } = require('../lib/dispatcher')
const config = require('../../config')

class PreferencesPage extends React.Component {
  constructor (props) {
    super(props)

    this.handleStartupChange =
      this.handleStartupChange.bind(this)

    this.handleSoundNotificationsChange =
      this.handleSoundNotificationsChange.bind(this)

    this.handleSetGlobalTrackers =
      this.handleSetGlobalTrackers.bind(this)

    this.handleTempPathChange = this.handleTempPathChange.bind(this)
    this.handleTempPathReset = this.handleTempPathReset.bind(this)
    this.handleClearTempNow = this.handleClearTempNow.bind(this)

    const globalTrackers = this.props.state.getGlobalTrackers().join('\n')

    this.state = {
      globalTrackers
    }
  }

  highestPlaybackPriorityCheckbox () {
    return (
      <Preference>
        <Checkbox
          className='control'
          checked={this.props.state.saved.prefs.highestPlaybackPriority}
          label='Highest Playback Priority'
          onCheck={this.handleHighestPlaybackPriorityChange}
        />
        <p>Pauses all active torrents to allow playback to use all of the available bandwidth.</p>
      </Preference>
    )
  }

  handleHighestPlaybackPriorityChange (e, isChecked) {
    dispatch('updatePreferences', 'highestPlaybackPriority', isChecked)
  }

  autoAddTorrentsCheckbox () {
    return (
      <Preference>
        <Checkbox
          className='control'
          checked={this.props.state.saved.prefs.autoAddTorrents}
          label='Watch for new .torrent files and add them immediately'
          onCheck={(e, value) => { this.handleAutoAddTorrentsChange(e, value) }}
        />
      </Preference>
    )
  }

  handleAutoAddTorrentsChange (e, isChecked) {
    const torrentsFolderPath = this.props.state.saved.prefs.torrentsFolderPath
    if (isChecked && !torrentsFolderPath) {
      alert('Select a torrents folder first.') // eslint-disable-line
      e.preventDefault()
      return
    }

    dispatch('updatePreferences', 'autoAddTorrents', isChecked)

    if (isChecked) {
      dispatch('startFolderWatcher')
      return
    }

    dispatch('stopFolderWatcher')
  }

  torrentsFolderPathSelector () {
    const torrentsFolderPath = this.props.state.saved.prefs.torrentsFolderPath

    return (
      <Preference>
        <PathSelector
          dialog={{
            title: 'Select folder to watch for new torrents',
            properties: ['openDirectory']
          }}
          onChange={this.handleTorrentsFolderPathChange}
          title='Folder to watch'
          value={torrentsFolderPath}
        />
      </Preference>
    )
  }

  handleTorrentsFolderPathChange (filePath) {
    dispatch('updatePreferences', 'torrentsFolderPath', filePath)
  }

  setDefaultAppButton () {
    const isFileHandler = this.props.state.saved.prefs.isFileHandler
    if (isFileHandler) {
      return (
        <Preference>
          <p>{config.APP_NAME} is your default torrent app. Hooray!</p>
        </Preference>
      )
    }
    return (
      <Preference>
        <p>{config.APP_NAME} is not currently the default torrent app.</p>
        <RaisedButton
          className='control'
          onClick={this.handleSetDefaultApp}
          label={'Make ' + config.APP_NAME + ' the default'}
        />
      </Preference>
    )
  }

  handleStartupChange (e, isChecked) {
    dispatch('updatePreferences', 'startup', isChecked)
  }

  setStartupCheckbox () {
    if (config.IS_PORTABLE) {
      return
    }

    return (
      <Preference>
        <Checkbox
          className='control'
          checked={this.props.state.saved.prefs.startup}
          label={'Open ' + config.APP_NAME + ' on startup'}
          onCheck={this.handleStartupChange}
        />
      </Preference>
    )
  }

  soundNotificationsCheckbox () {
    return (
      <Preference>
        <Checkbox
          className='control'
          checked={this.props.state.saved.prefs.soundNotifications}
          label='Enable sounds'
          onCheck={this.handleSoundNotificationsChange}
        />
      </Preference>
    )
  }

  handleSoundNotificationsChange (e, isChecked) {
    dispatch('updatePreferences', 'soundNotifications', isChecked)
  }

  handleSetDefaultApp () {
    dispatch('updatePreferences', 'isFileHandler', true)
  }

  setGlobalTrackers () {
    // Align the text fields
    const textFieldStyle = { width: '100%' }
    const textareaStyle = { margin: 0 }

    return (
      <Preference>
        <TextField
          className='torrent-trackers control'
          style={textFieldStyle}
          textareaStyle={textareaStyle}
          multiLine
          rows={2}
          rowsMax={10}
          value={this.state.globalTrackers}
          onChange={this.handleSetGlobalTrackers}
        />
      </Preference>
    )
  }

  handleSetGlobalTrackers (e, globalTrackers) {
    this.setState({ globalTrackers })

    const announceList = globalTrackers
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '')

    dispatch('updatePreferences', 'globalTrackers', announceList)
    dispatch('updateGlobalTrackers', announceList)
  }

  // Where files being streamed are kept. Everything in here is temporary and is
  // cleared when the app quits.
  tempPathSelector () {
    const prefs = this.props.state.saved.prefs
    const usage = this.props.state.tempUsage || {}
    const inUse = this.props.state.tempPath || config.TEMP_PATH
    const isDefault = !prefs.tempPath

    const noteStyle = {
      fontSize: 13,
      marginTop: 6,
      marginBottom: 6,
      overflowWrap: 'anywhere'
    }
    const buttonStyle = { marginRight: 10 }

    return (
      <Preference>
        <PathSelector
          dialog={{
            title: 'Choose where temporary video files go',
            properties: ['openDirectory']
          }}
          onChange={this.handleTempPathChange}
          title='Temporary files'
          value={isDefault ? inUse + '  (default)' : prefs.tempPath}
        />
        <div style={noteStyle}>
          Using <strong>{prettyBytes(usage.bytes || 0)}</strong>. Cleared when the app quits.
        </div>
        <RaisedButton
          className='control'
          label='Reset to default'
          style={buttonStyle}
          disabled={isDefault}
          onClick={this.handleTempPathReset}
        />
        <RaisedButton
          className='control'
          label='Clear now'
          onClick={this.handleClearTempNow}
        />
      </Preference>
    )
  }

  handleTempPathChange (filePath) {
    dispatch('updatePreferences', 'tempPath', filePath)
  }

  handleTempPathReset () {
    dispatch('resetTempFolder')
  }

  handleClearTempNow () {
    dispatch('clearTempNow')
  }

  // Casting can be switched off altogether, for people who never use it
  castingCheckbox () {
    return (
      <Preference>
        <Checkbox
          className='control'
          checked={!this.props.state.saved.prefs.hideCasting}
          label='Offer to play on a TV (Chromecast, AirPlay, DLNA)'
          onCheck={(e, value) => dispatch('updatePreferences', 'hideCasting', !value)}
        />
      </Preference>
    )
  }

  // What Next and Previous do while a search is open
  playlistFollowsSearchCheckbox () {
    return (
      <Preference>
        <Checkbox
          className='control'
          checked={this.props.state.saved.prefs.playlistFollowsSearch !== false}
          label='Next and Previous follow the search'
          onCheck={(e, value) =>
            dispatch('updatePreferences', 'playlistFollowsSearch', value)}
        />
        <p>
          While a search is open in a torrent, Next and Previous step through
          what the search found. With this off they always step through the
          torrent in the order its files are in.
        </p>
      </Preference>
    )
  }

  // Where new builds are kept: the folder holding RELEASES and the .nupkg
  // files that bin/package.js writes
  updateFolderSelector () {
    const updateFolder = this.props.state.saved.prefs.updateFolder || ''

    return (
      <Preference>
        <PathSelector
          dialog={{
            title: 'Choose the folder new builds are kept in',
            properties: ['openDirectory']
          }}
          onChange={(filePath) => dispatch('updatePreferences', 'updateFolder', filePath)}
          title='New builds folder'
          value={updateFolder}
        />
      </Preference>
    )
  }

  render () {
    const style = {
      color: colors.grey400,
      marginLeft: 25,
      marginRight: 25
    }
    return (
      <div style={style}>
        <PreferencesSection title='Folders'>
          {this.tempPathSelector()}
          {this.autoAddTorrentsCheckbox()}
          {this.torrentsFolderPathSelector()}
        </PreferencesSection>
        <PreferencesSection title='Playback'>
          {this.highestPlaybackPriorityCheckbox()}
          {this.playlistFollowsSearchCheckbox()}
          {this.castingCheckbox()}
        </PreferencesSection>
        <PreferencesSection title='Default torrent app'>
          {this.setDefaultAppButton()}
        </PreferencesSection>
        <PreferencesSection title='General'>
          {this.updateFolderSelector()}
          {this.setStartupCheckbox()}
          {this.soundNotificationsCheckbox()}
        </PreferencesSection>
        <PreferencesSection title='Trackers'>
          {this.setGlobalTrackers()}
        </PreferencesSection>
      </div>
    )
  }
}

class PreferencesSection extends React.Component {
  static get propTypes () {
    return {
      title: PropTypes.string
    }
  }

  render () {
    const style = {
      marginBottom: 25,
      marginTop: 25
    }
    return (
      <div style={style}>
        <Heading level={2}>{this.props.title}</Heading>
        {this.props.children}
      </div>
    )
  }
}

class Preference extends React.Component {
  render () {
    const style = { marginBottom: 10 }
    return (<div style={style}>{this.props.children}</div>)
  }
}

module.exports = PreferencesPage
