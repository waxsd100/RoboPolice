const sharp = require('sharp')

// Sizes Discord shows these images at. An event cover is a 2.5:1 banner; a forum post's first
// image is shown as a 16:9 thumbnail.
const SIZES = {
  eventCover: { width: 800, height: 320 },
  forumImage: { width: 1280, height: 720 }
}

// Refuse decompression bombs: a small file that expands to a huge pixel count.
const MAX_INPUT_PIXELS = 40 * 1000 * 1000

// How far the source's shape may be from the target's before cropping would cut away too much:
// at 1.6x a portrait poster fitted into a banner loses well over half of itself.
const MAX_CROP_STRETCH = 1.6

function load (buffer) {
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, animated: false }).rotate() // apply EXIF orientation
}

function toJpeg (image) {
  return image.flatten({ background: '#ffffff' }).jpeg({ quality: 85, mozjpeg: true }).toBuffer()
}

// Crops to `size`, keeping the part sharp's attention strategy finds most interesting (faces,
// saturated and high-contrast areas) rather than blindly the center. Natural for photos; cuts
// the text off posters whose shape is far from the target's.
async function cropTo (buffer, size) {
  return toJpeg(load(buffer).resize({ ...size, fit: 'cover', position: sharp.strategy.attention }))
}

// Shows the whole image, centered, over a blurred and darkened copy of itself that fills the rest
// of the frame: nothing is cut, which suits posters and flyers.
async function fitWithBlur (buffer, size) {
  const input = await load(buffer).toBuffer()
  const background = await sharp(input)
    .resize({ ...size, fit: 'cover' })
    .blur(24)
    .modulate({ brightness: 0.7 })
    .toBuffer()
  const foreground = await sharp(input).resize({ ...size, fit: 'inside', withoutEnlargement: false }).toBuffer()
  return toJpeg(sharp(background).composite([{ input: foreground, gravity: 'center' }]))
}

// Cropping for images close to the target's shape, the whole picture for anything else.
async function defaultMode (buffer, size) {
  const meta = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()
  // metadata() reports the stored size; EXIF orientations 5-8 are displayed rotated by 90°.
  const [width, height] = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height]
  const ratio = (width / height) / (size.width / size.height)
  return Math.max(ratio, 1 / ratio) > MAX_CROP_STRETCH ? 'fit' : 'crop'
}

// A reasonably small JPEG of the whole image, to send to the image model as a reference.
async function forReference (buffer) {
  return toJpeg(load(buffer).resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true }))
}

module.exports = { cropTo, fitWithBlur, defaultMode, forReference, SIZES }
