/**
 * Where the user got to in each video.
 *
 * Positions are stored on the file entries inside state.saved.torrents, which
 * is the same place the magnet links live, so they survive restarts, reboots
 * and the temp folder being cleared. The fields used here are:
 *
 *   currentTime    seconds into the video
 *   duration       length of the video in seconds
 *   finished       watched to the end (past FINISHED_FRACTION)
 *   played         opened at least once
 *   lastPlayedAt   when it was last opened, for "Continue watching"
 *   audioTrack     chosen audio track index
 *   selectedSubtitle / subtitleChoice / subtitleDelay   subtitle settings
 */

// Past this much of the video, treat it as watched
const FINISHED_FRACTION = 0.95

// Resume a few seconds earlier than where the user stopped, for context
const RESUME_REWIND_SECONDS = 5

// Below this, the user barely started: not worth resuming or listing
const MINIMUM_PROGRESS_SECONDS = 10

module.exports = {
  FINISHED_FRACTION,
  RESUME_REWIND_SECONDS,
  getFraction,
  hasProgress,
  isFinished,
  isWatched,
  getResumeTime,
  recordPosition,
  markFinished,
  clearProgress,
  getContinueWatching
}

function getFraction (file) {
  if (!file || !file.duration || !isFinite(file.duration) || file.duration <= 0) return 0
  const fraction = (file.currentTime || 0) / file.duration
  return Math.max(0, Math.min(1, fraction))
}

// Has the user got far enough in for the position to be worth showing?
function hasProgress (file) {
  return !!file && typeof file.currentTime === 'number' &&
    file.currentTime > MINIMUM_PROGRESS_SECONDS &&
    !!file.duration && isFinite(file.duration)
}

function isFinished (file) {
  if (!file) return false
  if (file.finished) return true
  return hasProgress(file) && getFraction(file) >= FINISHED_FRACTION
}

// What the checkmark in the file list means. Images and anything without a
// duration count as watched once they have been opened.
function isWatched (file) {
  if (!file) return false
  if (isFinished(file)) return true
  return !!file.played && !file.duration
}

// Where playback should start. Zero means from the beginning.
function getResumeTime (file) {
  if (!hasProgress(file) || isFinished(file)) return 0
  return Math.max(0, file.currentTime - RESUME_REWIND_SECONDS)
}

// Called while playing, and whenever playback stops
function recordPosition (file, currentTime, duration) {
  if (!file) return false

  // A length the position is already past is not a length: the player can
  // report a few seconds for a file it has only part of, and writing that
  // down would make the video look watched to the end
  const past = typeof currentTime === 'number' && isFinite(currentTime)
    ? currentTime
    : 0
  if (typeof duration === 'number' && isFinite(duration) && duration > 0 &&
    duration >= past) {
    file.duration = duration
  }
  if (typeof currentTime === 'number' && isFinite(currentTime) && currentTime >= 0) {
    file.currentTime = currentTime
  }

  // Reaching the end counts as watched, and clears the resume point so the
  // next play starts from the beginning
  if (getFraction(file) >= FINISHED_FRACTION) {
    file.finished = true
    return true
  }

  // Watching a finished video again puts it back among the unfinished once
  // the user is properly into it. Without this the mark stayed on for good:
  // the offer to pick up where they left off never came back, and the video
  // never returned to Continue watching, however far in they got.
  if (file.finished && hasProgress(file)) file.finished = false

  return false
}

function markFinished (file) {
  if (!file) return
  file.finished = true
  file.played = true
}

function clearProgress (file) {
  if (!file) return
  delete file.currentTime
  delete file.finished
  delete file.lastPlayedAt
}

/**
 * The videos the user stopped partway through, most recent first, for the
 * "Continue watching" row at the top of the list.
 */
function getContinueWatching (state, limit = 6) {
  const entries = []

  for (const torrentSummary of state.saved.torrents) {
    if (!torrentSummary.files) continue

    torrentSummary.files.forEach((file, index) => {
      if (!hasProgress(file) || isFinished(file)) return
      entries.push({
        torrentSummary,
        file,
        index,
        lastPlayedAt: file.lastPlayedAt || 0
      })
    })
  }

  entries.sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
  return entries.slice(0, limit)
}
