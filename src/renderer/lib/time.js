module.exports = {
  calculateEta,
  formatPosition
}

// Seconds as "12:34", or "1:02:03" once past an hour. Used for saved playback
// positions, in the file list and in the player.
function formatPosition (seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds) || seconds < 0) return '0:00'

  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  const secs = Math.floor(seconds % 60)

  const mm = hours > 0 && minutes < 10 ? '0' + minutes : String(minutes)
  const ss = secs < 10 ? '0' + secs : String(secs)

  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

function calculateEta (missing, downloadSpeed) {
  if (downloadSpeed === 0 || missing === 0) return

  const rawEta = missing / downloadSpeed
  const hours = Math.floor(rawEta / 3600) % 24
  const minutes = Math.floor(rawEta / 60) % 60
  const seconds = Math.floor(rawEta % 60)

  // Only display hours and minutes if they are greater than 0 but always
  // display minutes if hours is being displayed
  const hoursStr = hours ? hours + ' h' : ''
  const minutesStr = (hours || minutes) ? minutes + ' min' : ''
  const secondsStr = seconds + ' s'

  return `${hoursStr} ${minutesStr} ${secondsStr} remaining`
}
