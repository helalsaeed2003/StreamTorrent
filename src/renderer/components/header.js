const React = require('react')

const { dispatch, dispatcher } = require('../lib/dispatcher')

// The pointer's own position goes with the move, so that a mousemove sent
// because a window came or went under the pointer, rather than because it
// moved, is ignored
function handleMouseMove (e) {
  dispatch('mediaMouseMoved', undefined, e.screenX, e.screenY)
}

class Header extends React.Component {
  render () {
    return (
      <div
        className='header'
        onMouseMove={handleMouseMove}
        onMouseEnter={dispatcher('mediaControlsMouseEnter')}
        onMouseLeave={dispatcher('mediaControlsMouseLeave')}
        role='navigation'
      >
        {this.getTitle()}
        <div className='nav left float-left'>
          {this.getBackButton()}
        </div>
        <div className='nav right float-right'>
          {this.getAddButton()}
        </div>
      </div>
    )
  }

  /**
   * The arrow shows on every screen except the torrent list, and always goes
   * back to that list. There is no forward arrow: there is nowhere forward
   * to go.
   */
  getBackButton () {
    if (this.props.state.location.url() === 'home') return null
    return (
      <i
        className='icon back'
        title='Back to the list'
        onClick={dispatcher('backToList')}
        role='button'
        aria-label='Back to the list'
      >
        chevron_left
      </i>
    )
  }

  getTitle () {
    if (process.platform !== 'darwin') return null
    const state = this.props.state
    return (<div className='title ellipsis'>{state.window.title}</div>)
  }

  getAddButton () {
    const state = this.props.state
    if (state.location.url() !== 'home') return null
    return (
      <i
        className='icon add'
        title='Add torrent'
        onClick={dispatcher('openFiles')}
        role='button'
      >
        add
      </i>
    )
  }
}

module.exports = Header
