const sharp = require('sharp')

// Sizes Discord shows these images at. An event cover is a 2.5:1 banner; a forum post's first
// image is shown as a 16:9 thumbnail.
const SIZES = {
  eventCover: { width: 800, height: 320 },
  forumImage: { width: 1280, height: 720 }
}

// Refuse decompression bombs: a small file that expands to a huge pixel count.
const MAX_INPUT_PIXELS = 40 * 1000 * 1000

// Crops to `size`, keeping the part sharp's attention strategy finds most interesting (faces,
// saturated and high-contrast areas) rather than blindly the center. Returns a JPEG.
async function cropTo (buffer, size) {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false })
    .rotate() // apply EXIF orientation before cropping
    .resize({ ...size, fit: 'cover', position: sharp.strategy.attention })
    .flatten({ background: '#ffffff' }) // JPEG has no alpha
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer()
}

module.exports = { cropTo, SIZES }
