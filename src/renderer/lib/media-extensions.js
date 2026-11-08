const mediaExtensions = {
  audio: [
    '.aac', '.aif', '.aiff', '.asf', '.dff', '.dsf', '.flac', '.m2a',
    '.m2a', '.m4a', '.mpc', '.m4b', '.mka', '.mp2', '.mp3', '.mpc', '.oga',
    '.ogg', '.opus', '.spx', '.wma', '.wav', '.wv', '.wvp'],
  video: [
    '.avi', '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.mpg', '.mpeg',
    '.ogv', '.webm', '.wmv', '.m2ts', '.ts', '.mts', '.flv', '.vob',
    '.divx', '.3gp', '.rm', '.rmvb'],
  image: ['.gif', '.jpg', '.jpeg', '.png', '.webp', '.bmp'],

  // Containers / codecs that Chromium's built-in <video>/<audio> element cannot
  // decode. Rather than letting playback fail and showing the "unsupported
  // media" popup, these are handed straight to the external player (VLC).
  // Formats that Chromium *sometimes* handles (e.g. .mkv, which plays when it
  // holds H.264/AAC but not when it holds HEVC/AC3) are deliberately NOT listed
  // here: those are tried in the built-in player first and fall back to VLC
  // automatically when decoding fails.
  externalOnly: [
    '.avi', '.wmv', '.asf', '.flv', '.mpg', '.mpeg', '.m2ts', '.ts', '.mts',
    '.vob', '.divx', '.rm', '.rmvb', '.3gp',
    '.wma', '.dff', '.dsf', '.wv', '.wvp', '.mpc', '.spx', '.aif', '.aiff']
}

module.exports = mediaExtensions
