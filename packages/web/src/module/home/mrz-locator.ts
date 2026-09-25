export type Region = {
  left: number
  top: number
  width: number
  height: number
}

const ANALYSIS_WIDTH = 900
const MIN_BAND_HEIGHT = 5
const BAND_GAP = 2
const MIN_TRANSITIONS = 24
const EDGE_COLUMN_FILL = 0.85
const MAX_HEIGHT_DIFFERENCE = 0.4
const MAX_PITCH_DIFFERENCE = 0.3
const MIN_OVERLAP = 0.7
const MIN_WIDTH_SHARE = 0.25
const PADDING_HEIGHTS = 0.7
const SIDE_PADDING_HEIGHTS = 1
const BORDER_MARGIN = 0.01

type Band = { top: number; bottom: number; left: number; right: number }

const LOCAL_RADIUS = 14
const LOCAL_CONTRAST = 18

const localMeans = (
  gray: Uint8Array,
  width: number,
  height: number,
): Float32Array => {
  const integral = new Float64Array((width + 1) * (height + 1))
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0
    for (let x = 0; x < width; x += 1) {
      rowSum += gray[y * width + x]
      integral[(y + 1) * (width + 1) + x + 1] =
        integral[y * (width + 1) + x + 1] + rowSum
    }
  }
  const means = new Float32Array(gray.length)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - LOCAL_RADIUS)
      const y0 = Math.max(0, y - LOCAL_RADIUS)
      const x1 = Math.min(width, x + LOCAL_RADIUS + 1)
      const y1 = Math.min(height, y + LOCAL_RADIUS + 1)
      const sum =
        integral[y1 * (width + 1) + x1] -
        integral[y0 * (width + 1) + x1] -
        integral[y1 * (width + 1) + x0] +
        integral[y0 * (width + 1) + x0]
      means[y * width + x] = sum / ((x1 - x0) * (y1 - y0))
    }
  return means
}

const binarize = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { ink: Uint8Array; width: number; height: number } => {
  const scale = Math.min(1, ANALYSIS_WIDTH / width)
  const outWidth = Math.max(1, Math.round(width * scale))
  const outHeight = Math.max(1, Math.round(height * scale))
  const gray = new Uint8Array(outWidth * outHeight)
  for (let y = 0; y < outHeight; y += 1)
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale))
      const sourceY = Math.min(height - 1, Math.floor(y / scale))
      const offset = (sourceY * width + sourceX) * 4
      gray[y * outWidth + x] = Math.round(
        pixels[offset] * 0.299 +
          pixels[offset + 1] * 0.587 +
          pixels[offset + 2] * 0.114,
      )
    }
  const means = localMeans(gray, outWidth, outHeight)
  const ink = new Uint8Array(gray.length)
  for (let index = 0; index < gray.length; index += 1)
    ink[index] = gray[index] < means[index] - LOCAL_CONTRAST ? 1 : 0
  return { ink, width: outWidth, height: outHeight }
}

const findBands = (ink: Uint8Array, width: number, height: number): Band[] => {
  const textRow = new Uint8Array(height)
  for (let y = 0; y < height; y += 1) {
    let transitions = 0
    for (let x = 1; x < width; x += 1)
      if (ink[y * width + x] !== ink[y * width + x - 1]) transitions += 1
    textRow[y] = transitions >= MIN_TRANSITIONS ? 1 : 0
  }
  const rows: { top: number; bottom: number }[] = []
  let start = -1
  let gap = 0
  for (let y = 0; y <= height; y += 1) {
    if (y < height && textRow[y]) {
      if (start < 0) start = y
      gap = 0
    } else if (start >= 0) {
      gap += 1
      if (gap > BAND_GAP || y === height) {
        rows.push({ top: start, bottom: y - gap })
        start = -1
        gap = 0
      }
    }
  }
  const bands: Band[] = []
  for (const { top, bottom } of rows) {
    if (bottom - top + 1 < MIN_BAND_HEIGHT) continue
    const bandHeight = bottom - top + 1
    let left = width
    let right = -1
    for (let x = 0; x < width; x += 1) {
      let dark = 0
      for (let y = top; y <= bottom; y += 1) dark += ink[y * width + x]
      if (dark > 0 && dark / bandHeight < EDGE_COLUMN_FILL) {
        if (x < left) left = x
        if (x > right) right = x
      }
    }
    if (right > left) bands.push({ top, bottom, left, right })
  }
  return bands
}

const overlap = (first: Band, second: Band): number =>
  Math.max(
    0,
    Math.min(first.right, second.right) - Math.max(first.left, second.left),
  ) /
  Math.max(1, Math.min(first.right - first.left, second.right - second.left))

const isMrzTriple = (bands: Band[], width: number): boolean => {
  const heights = bands.map((band) => band.bottom - band.top + 1)
  const tallest = Math.max(...heights)
  const shortest = Math.min(...heights)
  if ((tallest - shortest) / tallest > MAX_HEIGHT_DIFFERENCE) return false
  const first = bands[1].top - bands[0].top
  const second = bands[2].top - bands[1].top
  if (Math.abs(first - second) / Math.max(first, second) > MAX_PITCH_DIFFERENCE)
    return false
  if (
    overlap(bands[0], bands[1]) < MIN_OVERLAP ||
    overlap(bands[1], bands[2]) < MIN_OVERLAP
  )
    return false
  const spanned =
    Math.max(...bands.map((band) => band.right)) -
    Math.min(...bands.map((band) => band.left))
  return spanned >= width * MIN_WIDTH_SHARE
}

export const locateMrz = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): Region | null => {
  const analysis = binarize(pixels, width, height)
  const bands = findBands(analysis.ink, analysis.width, analysis.height)
  for (let last = bands.length - 1; last >= 2; last -= 1) {
    const triple = [bands[last - 2], bands[last - 1], bands[last]]
    if (!isMrzTriple(triple, analysis.width)) continue
    const lineHeight = Math.max(
      ...triple.map((band) => band.bottom - band.top + 1),
    )
    const factor = width / analysis.width
    const left =
      Math.min(...triple.map((band) => band.left)) -
      lineHeight * SIDE_PADDING_HEIGHTS
    const right =
      Math.max(...triple.map((band) => band.right)) +
      lineHeight * SIDE_PADDING_HEIGHTS
    const top = triple[0].top - lineHeight * PADDING_HEIGHTS
    const bottom = triple[2].bottom + lineHeight * PADDING_HEIGHTS
    const margin = Math.round(width * BORDER_MARGIN)
    const region = {
      left: Math.max(margin, Math.round(left * factor)),
      top: Math.max(0, Math.round(top * factor)),
      width: 0,
      height: 0,
    }
    region.width =
      Math.min(width - margin, Math.round(right * factor)) - region.left
    region.height = Math.min(height, Math.round(bottom * factor)) - region.top
    return region.width > 20 && region.height > 20 ? region : null
  }
  return null
}

const BOTTOM_SHARE = 0.45

export const bottomRegion = (width: number, height: number): Region => {
  const top = Math.round(height * (1 - BOTTOM_SHARE))
  return { left: 0, top, width, height: height - top }
}
