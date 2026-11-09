#!/usr/bin/env node

/**
 * Draws the StreamTorrent app icon and writes it out as the .png and .ico files
 * the app and the Windows build need.
 *
 * Everything is drawn here rather than shipped as a binary, so the icon can be
 * tweaked by editing the numbers below and re-running:
 *
 *   node bin/make-icons.js
 *
 * NOTE: the app icon it draws is NOT the one in use. static/StreamTorrent.ico
 * and .png now hold the icon the user picked instead, which running this would
 * overwrite. Only the .torrent file icon still comes from here.
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const STATIC_PATH = path.join(__dirname, '..', 'static')

// Sizes that go inside the .ico. Windows picks whichever it needs.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const PNG_SIZE = 512

// --- the drawing ----------------------------------------------------------

const APP_COLOURS = {
  topLeft: [0x5b, 0x2b, 0xd8], // indigo
  bottomRight: [0x00, 0xc2, 0xa8], // teal
  mark: [0xff, 0xff, 0xff]
}

const FILE_COLOURS = {
  topLeft: [0xf5, 0xf6, 0xfa], // near-white "page"
  bottomRight: [0xd8, 0xdd, 0xea],
  mark: [0x5b, 0x2b, 0xd8]
}

// Signed distance to a rounded rectangle, in normalised coordinates.
// Negative inside, positive outside.
function roundedRectDistance (x, y, left, top, right, bottom, radius) {
  const cx = Math.max(left + radius, Math.min(right - radius, x))
  const cy = Math.max(top + radius, Math.min(bottom - radius, y))
  const dx = x - cx
  const dy = y - cy
  const d = Math.sqrt(dx * dx + dy * dy) - radius

  const insideX = x > left + radius && x < right - radius
  const insideY = y > top + radius && y < bottom - radius
  if (insideX || insideY) {
    // Within the straight edges: distance to the nearest edge
    return Math.max(left - x, x - right, top - y, y - bottom)
  }
  return d
}

// Is this point inside the play triangle?
function playTriangleDistance (x, y) {
  // A triangle pointing right, roughly centred, with its tip slightly right of
  // centre so it looks balanced
  const ax = 0.375; const ay = 0.275
  const bx = 0.375; const by = 0.725
  const cx = 0.735; const cy = 0.5

  // Distance to the triangle: negative inside
  const edges = [[ax, ay, bx, by], [bx, by, cx, cy], [cx, cy, ax, ay]]
  let inside = true
  let minDist = Infinity

  for (const [x1, y1, x2, y2] of edges) {
    // Cross product tells us which side of the edge we are on
    const cross = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
    if (cross > 0) inside = false

    // Distance to this segment
    const vx = x2 - x1; const vy = y2 - y1
    const len2 = vx * vx + vy * vy
    let t = len2 === 0 ? 0 : ((x - x1) * vx + (y - y1) * vy) / len2
    t = Math.max(0, Math.min(1, t))
    const px = x1 + t * vx; const py = y1 + t * vy
    minDist = Math.min(minDist, Math.hypot(x - px, y - py))
  }

  return inside ? -minDist : minDist
}

// Colour and coverage at one point, in normalised coordinates
function shade (x, y, colours, isFileIcon) {
  const inset = 0.035
  const radius = isFileIcon ? 0.10 : 0.215
  const bg = roundedRectDistance(x, y, inset, inset, 1 - inset, 1 - inset, radius)
  if (bg > 0) return null

  // Diagonal gradient
  const t = Math.max(0, Math.min(1, (x + y) / 2))
  const colour = [0, 1, 2].map(i =>
    Math.round(colours.topLeft[i] + (colours.bottomRight[i] - colours.topLeft[i]) * t))

  // The play mark sits on top
  if (playTriangleDistance(x, y) <= 0) return colours.mark

  return colour
}

// Renders one square image, with anti-aliasing by sampling each pixel a few
// times. Returns raw RGBA bytes.
function render (size, colours, isFileIcon) {
  const samples = size <= 32 ? 4 : 3
  const rgba = Buffer.alloc(size * size * 4)

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0; let g = 0; let b = 0; let hits = 0

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size
          const y = (py + (sy + 0.5) / samples) / size
          const colour = shade(x, y, colours, isFileIcon)
          if (colour) {
            r += colour[0]; g += colour[1]; b += colour[2]
            hits++
          }
        }
      }

      const total = samples * samples
      const offset = (py * size + px) * 4
      if (hits === 0) continue
      rgba[offset] = Math.round(r / hits)
      rgba[offset + 1] = Math.round(g / hits)
      rgba[offset + 2] = Math.round(b / hits)
      rgba[offset + 3] = Math.round(255 * hits / total)
    }
  }

  return rgba
}

// --- PNG encoding ---------------------------------------------------------

let crcTable = null
function crc32 (buf) {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      crcTable[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function pngChunk (type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng (size, rgba) {
  // One filter byte (0 = none) in front of every row
  const raw = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const src = y * size * 4
    const dst = y * (1 + size * 4)
    raw[dst] = 0
    rgba.copy(raw, dst + 1, src, src + size * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour with alpha
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// --- ICO encoding ---------------------------------------------------------

// Each image is stored as a PNG inside the .ico, which Windows has understood
// since Vista.
function encodeIco (images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((image, i) => {
    const entry = i * 16
    directory[entry] = image.size >= 256 ? 0 : image.size // 0 means 256
    directory[entry + 1] = image.size >= 256 ? 0 : image.size
    directory[entry + 2] = 0 // palette size
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.png.length
  })

  return Buffer.concat([header, directory, ...images.map(i => i.png)])
}

// --- write everything out -------------------------------------------------

function buildIcon (name, colours, isFileIcon) {
  const images = ICO_SIZES.map(size => ({
    size,
    png: encodePng(size, render(size, colours, isFileIcon))
  }))

  const icoPath = path.join(STATIC_PATH, name + '.ico')
  fs.writeFileSync(icoPath, encodeIco(images))
  console.log('wrote ' + icoPath)

  const pngPath = path.join(STATIC_PATH, name + '.png')
  fs.writeFileSync(pngPath, encodePng(PNG_SIZE, render(PNG_SIZE, colours, isFileIcon)))
  console.log('wrote ' + pngPath)
}

buildIcon('StreamTorrent', APP_COLOURS, false)
buildIcon('StreamTorrentFile', FILE_COLOURS, true)
