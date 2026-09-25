import type { Bbox } from "tesseract.js"
import type { ImageSize, Zone } from "./id-card-anchors"

// The back of the card has no labels the OCR reads reliably (they are tiny
// and italic), but it has the MRZ: crisp, standardised and always in the same
// place. The MRZ lines are the anchor: their width gives the horizontal scale
// and their spacing the vertical one, and everything printed above them
// follows from the template.
//
// Positions were measured on a real card back photographed, corrected and
// enlarged to 1800x1206.

type Box = [number, number, number, number]

const TEMPLATE = { width: 1800, height: 1206 }

// Where the three MRZ lines sit on the template: the horizontal extent of the
// 30 characters, and the vertical centre of each line.
const MRZ = { left: 96, right: 1697, centres: [825.5, 911, 1000.5] }

const ADDRESS_LEFT = 560
const ADDRESS_RIGHT = 1720
const ADDRESS_FIRST_TOP = 188
const ADDRESS_LINE_PITCH = 44
const ADDRESS_LINE_HEIGHT = 52
export const MAX_ADDRESS_LINES = 4

const VALUES: { field: Zone["field"]; part: Zone["part"]; box: Box }[] = [
  { field: "maritalStatus", part: "cyrillic", box: [560, 472, 1040, 530] },
  { field: "maritalStatus", part: "latin", box: [560, 472, 1040, 530] },
  { field: "bloodGroup", part: "value", box: [1046, 476, 1420, 526] },
  { field: "taxId", part: "value", box: [1435, 474, 1780, 534] },
  { field: "authority", part: "cyrillic", box: [560, 560, 1760, 614] },
]

type Transform = { sx: number; tx: number; sy: number; ty: number }

const MIN_SCALE = 0.3
const MAX_SCALE = 4
// The two axes may differ a little (corners placed by hand), not wildly.
const MAX_ASPECT_DRIFT = 1.25

const median = (values: number[]): number => {
  const sorted = [...values].sort((first, second) => first - second)
  return sorted[Math.floor(sorted.length / 2)]
}

// Without MRZ lines to anchor on, the corrected image is taken to be the
// card itself.
const bySize = (image: ImageSize): Transform => ({
  sx: image.width / TEMPLATE.width,
  tx: 0,
  sy: image.height / TEMPLATE.height,
  ty: 0,
})

const registerByMrz = (lines: Bbox[], image: ImageSize): Transform => {
  const fallback = bySize(image)
  if (lines.length !== MRZ.centres.length) return fallback
  const ordered = [...lines].sort((first, second) => first.y0 - second.y0)
  const left = median(ordered.map((line) => line.x0))
  const right = median(ordered.map((line) => line.x1))
  const sx = (right - left) / (MRZ.right - MRZ.left)
  const actual = ordered.map((line) => (line.y0 + line.y1) / 2)
  const meanActual =
    actual.reduce((sum, value) => sum + value, 0) / actual.length
  const meanTemplate =
    MRZ.centres.reduce((sum, value) => sum + value, 0) / MRZ.centres.length
  let covariance = 0
  let variance = 0
  actual.forEach((value, index) => {
    covariance += (MRZ.centres[index] - meanTemplate) * (value - meanActual)
    variance += (MRZ.centres[index] - meanTemplate) ** 2
  })
  const sy = covariance / variance
  const usable = (scale: number) =>
    Number.isFinite(scale) && scale >= MIN_SCALE && scale <= MAX_SCALE
  if (!usable(sx) || !usable(sy)) return fallback
  if (Math.max(sx / sy, sy / sx) > MAX_ASPECT_DRIFT) return fallback
  return {
    sx,
    tx: left - sx * MRZ.left,
    sy,
    ty: meanActual - sy * meanTemplate,
  }
}

const place = (transform: Transform, box: Box, image: ImageSize): Bbox => ({
  x0: Math.max(0, transform.sx * box[0] + transform.tx),
  y0: Math.max(0, transform.sy * box[1] + transform.ty),
  x1: Math.min(image.width, transform.sx * box[2] + transform.tx),
  y1: Math.min(image.height, transform.sy * box[3] + transform.ty),
})

export const locateBackZones = (mrzLines: Bbox[], image: ImageSize): Zone[] => {
  const transform = registerByMrz(mrzLines, image)
  const addressLines: Zone[] = Array.from(
    { length: MAX_ADDRESS_LINES },
    (_, line): Zone => {
      const top = ADDRESS_FIRST_TOP + line * ADDRESS_LINE_PITCH
      return {
        field: "address",
        part: "value",
        line,
        rect: place(
          transform,
          [ADDRESS_LEFT, top, ADDRESS_RIGHT, top + ADDRESS_LINE_HEIGHT],
          image,
        ),
      }
    },
  )
  return [
    ...addressLines,
    ...VALUES.map(({ field, part, box }): Zone => ({
      field,
      part,
      rect: place(transform, box, image),
    })),
  ].filter(
    (zone) =>
      zone.rect.x1 - zone.rect.x0 > 20 && zone.rect.y1 - zone.rect.y0 > 10,
  )
}
