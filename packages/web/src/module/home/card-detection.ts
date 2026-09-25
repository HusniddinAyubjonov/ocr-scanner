import type { DocumentCorners, Point } from "./scanner.types"

// Finds a card or sheet lying on a differently coloured surface by colour
// alone: a document is bright and pale, a table is darker or more saturated.
// Pixels are split in two by that, the regions are labelled, and the one that
// is a large convex quadrilateral is the document. Its four corners are the
// extreme points along the two diagonals, so a document that runs off the
// edge of the frame gets corners on the frame edge instead of being clipped.

export type CardDetection = { corners: DocumentCorners; confidence: number }

const SATURATION_WEIGHT = 0.5
const MIN_AREA_RATIO = 0.08
const MAX_AREA_RATIO = 0.9
const MIN_RECTANGULARITY = 0.85
const MIN_SIDE_RATIO = 0.15

// Brightness minus colourfulness: high for paper, plastic and white cards,
// low for wood, cloth and shadow.
const paleness = (pixels: Uint8ClampedArray): Float32Array => {
  const values = new Float32Array(pixels.length / 4)
  for (let index = 0; index < values.length; index += 1) {
    const red = pixels[index * 4]
    const green = pixels[index * 4 + 1]
    const blue = pixels[index * 4 + 2]
    const maximum = Math.max(red, green, blue)
    const saturation =
      maximum === 0 ? 0 : (maximum - Math.min(red, green, blue)) / maximum
    values[index] = maximum / 255 - SATURATION_WEIGHT * saturation
  }
  return values
}

const boxBlur = (
  source: Float32Array,
  width: number,
  height: number,
): Float32Array => {
  const horizontal = new Float32Array(source.length)
  const output = new Float32Array(source.length)
  const radius = 2
  for (let row = 0; row < height; row += 1)
    for (let column = 0; column < width; column += 1) {
      let sum = 0
      let count = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const x = column + offset
        if (x >= 0 && x < width) {
          sum += source[row * width + x]
          count += 1
        }
      }
      horizontal[row * width + column] = sum / count
    }
  for (let row = 0; row < height; row += 1)
    for (let column = 0; column < width; column += 1) {
      let sum = 0
      let count = 0
      for (let offset = -radius; offset <= radius; offset += 1) {
        const y = row + offset
        if (y >= 0 && y < height) {
          sum += horizontal[y * width + column]
          count += 1
        }
      }
      output[row * width + column] = sum / count
    }
  return output
}

const BINS = 128

const otsuThreshold = (values: Float32Array): number => {
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    if (value < minimum) minimum = value
    if (value > maximum) maximum = value
  }
  const range = maximum - minimum
  if (range < 1e-6) return minimum
  const histogram = new Float64Array(BINS)
  for (const value of values)
    histogram[
      Math.min(BINS - 1, Math.floor(((value - minimum) / range) * BINS))
    ] += 1
  const total = values.length
  let weightedSum = 0
  for (let bin = 0; bin < BINS; bin += 1) weightedSum += bin * histogram[bin]
  let backgroundWeight = 0
  let backgroundSum = 0
  let best = { variance: -1, bin: 0 }
  for (let bin = 0; bin < BINS; bin += 1) {
    backgroundWeight += histogram[bin]
    if (backgroundWeight === 0) continue
    const foregroundWeight = total - backgroundWeight
    if (foregroundWeight === 0) break
    backgroundSum += bin * histogram[bin]
    const backgroundMean = backgroundSum / backgroundWeight
    const foregroundMean = (weightedSum - backgroundSum) / foregroundWeight
    const variance =
      backgroundWeight *
      foregroundWeight *
      (backgroundMean - foregroundMean) ** 2
    if (variance > best.variance) best = { variance, bin }
  }
  return minimum + ((best.bin + 1) / BINS) * range
}

type Region = {
  area: number
  points: Point[]
  topLeft: Point
  topRight: Point
  bottomRight: Point
  bottomLeft: Point
}

// Labels 4-connected regions of set pixels; keeps only what is needed to
// judge each one: its area, its boundary pixels and its four extreme points.
const findRegions = (
  mask: Uint8Array,
  width: number,
  height: number,
): Region[] => {
  const visited = new Uint8Array(mask.length)
  const regions: Region[] = []
  const stack = new Int32Array(mask.length)
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue
    let top = 0
    stack[top++] = start
    visited[start] = 1
    const points: Point[] = []
    let area = 0
    let topLeft: Point = { x: Infinity, y: Infinity }
    let topRight: Point = { x: -Infinity, y: Infinity }
    let bottomRight: Point = { x: -Infinity, y: -Infinity }
    let bottomLeft: Point = { x: Infinity, y: -Infinity }
    while (top > 0) {
      const index = stack[--top]
      const x = index % width
      const y = (index - x) / width
      area += 1
      const sum = x + y
      const difference = x - y
      if (sum < topLeft.x + topLeft.y) topLeft = { x, y }
      if (sum > bottomRight.x + bottomRight.y) bottomRight = { x, y }
      if (difference > topRight.x - topRight.y) topRight = { x, y }
      if (difference < bottomLeft.x - bottomLeft.y) bottomLeft = { x, y }
      let boundary = false
      const neighbours = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ]
      for (const neighbour of neighbours) {
        if (neighbour < 0 || !mask[neighbour]) {
          boundary = true
          continue
        }
        if (!visited[neighbour]) {
          visited[neighbour] = 1
          stack[top++] = neighbour
        }
      }
      if (boundary) points.push({ x, y })
    }
    regions.push({ area, points, topLeft, topRight, bottomRight, bottomLeft })
  }
  return regions
}

const cross = (origin: Point, first: Point, second: Point): number =>
  (first.x - origin.x) * (second.y - origin.y) -
  (first.y - origin.y) * (second.x - origin.x)

const convexHull = (points: Point[]): Point[] => {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  if (sorted.length < 3) return sorted
  const lower: Point[] = []
  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    )
      lower.pop()
    lower.push(point)
  }
  const upper: Point[] = []
  for (const point of [...sorted].reverse()) {
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    )
      upper.pop()
    upper.push(point)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

const polygonArea = (polygon: Point[]): number => {
  let sum = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const next = polygon[(index + 1) % polygon.length]
    sum += polygon[index].x * next.y - next.x * polygon[index].y
  }
  return Math.abs(sum) / 2
}

const distance = (first: Point, second: Point): number =>
  Math.hypot(second.x - first.x, second.y - first.y)

type Candidate = { corners: Point[]; rectangularity: number }

const bestCandidate = (
  mask: Uint8Array,
  width: number,
  height: number,
): Candidate | null => {
  let best: { candidate: Candidate; area: number } | null = null
  for (const region of findRegions(mask, width, height)) {
    const hull = convexHull(region.points)
    const hullArea = polygonArea(hull)
    const areaRatio = hullArea / (width * height)
    if (areaRatio < MIN_AREA_RATIO || areaRatio > MAX_AREA_RATIO) continue
    const corners = [
      region.topLeft,
      region.topRight,
      region.bottomRight,
      region.bottomLeft,
    ]
    const rectangularity = polygonArea(corners) / hullArea
    const shortest = Math.min(
      distance(corners[0], corners[1]),
      distance(corners[1], corners[2]),
      distance(corners[2], corners[3]),
      distance(corners[3], corners[0]),
    )
    if (
      rectangularity < MIN_RECTANGULARITY ||
      shortest < Math.min(width, height) * MIN_SIDE_RATIO
    )
      continue
    if (!best || hullArea > best.area)
      best = { candidate: { corners, rectangularity }, area: hullArea }
  }
  return best?.candidate ?? null
}

// A colour threshold can merge the document with a bright patch of the
// surface (a glare on a table), and at that threshold the outline is wrong.
// The document's own outline is the one that stays put as the threshold moves
// through a range, so several thresholds are tried and the longest run of
// agreeing outlines wins.
// The region's edge sits where the colour crosses the threshold, which on a
// card with a shaded rim is a little inside the card. Every edge is moved
// outward by this share of the image and adjacent edges re-intersected.
const OUTWARD_OFFSET = 0.012

const THRESHOLD_STEP = 0.05
const THRESHOLD_LEVELS = 10
const START_OFFSET = -0.05
const MIN_STABLE_RUN = 3
const STABLE_MOVEMENT = 0.04

const expandQuad = (
  corners: Point[],
  offset: number,
  width: number,
  height: number,
): Point[] => {
  const centre = {
    x: corners.reduce((sum, point) => sum + point.x, 0) / corners.length,
    y: corners.reduce((sum, point) => sum + point.y, 0) / corners.length,
  }
  // Each edge as a line n·p = c, with n pointing away from the centre.
  const lines = corners.map((start, index) => {
    const end = corners[(index + 1) % corners.length]
    const length = Math.max(1e-6, distance(start, end))
    let normal = {
      x: (end.y - start.y) / length,
      y: -(end.x - start.x) / length,
    }
    if (normal.x * (start.x - centre.x) + normal.y * (start.y - centre.y) < 0)
      normal = { x: -normal.x, y: -normal.y }
    return { normal, offset: normal.x * start.x + normal.y * start.y + offset }
  })
  return corners.map((_, index) => {
    const previous = lines[(index + lines.length - 1) % lines.length]
    const next = lines[index]
    const determinant =
      previous.normal.x * next.normal.y - previous.normal.y * next.normal.x
    if (Math.abs(determinant) < 1e-6) return corners[index]
    const x =
      (previous.offset * next.normal.y - previous.normal.y * next.offset) /
      determinant
    const y =
      (previous.normal.x * next.offset - previous.offset * next.normal.x) /
      determinant
    return {
      x: Math.max(0, Math.min(width - 1, x)),
      y: Math.max(0, Math.min(height - 1, y)),
    }
  })
}

const sameQuad = (
  first: Point[],
  second: Point[],
  tolerance: number,
): boolean =>
  first.every((point, index) => distance(point, second[index]) <= tolerance)

export const detectCardQuad = (
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): CardDetection | null => {
  const feature = boxBlur(paleness(pixels), width, height)
  const base = otsuThreshold(feature)
  const tolerance = STABLE_MOVEMENT * Math.max(width, height)
  let best: { run: Candidate[]; light: boolean } | null = null
  for (const light of [true, false]) {
    let run: Candidate[] = []
    const consider = () => {
      if (
        run.length >= MIN_STABLE_RUN &&
        (!best || run.length > best.run.length)
      )
        best = { run, light }
    }
    for (let level = 0; level < THRESHOLD_LEVELS; level += 1) {
      const threshold = base + START_OFFSET + level * THRESHOLD_STEP
      const mask = new Uint8Array(feature.length)
      for (let index = 0; index < feature.length; index += 1)
        mask[index] = feature[index] > threshold === light ? 1 : 0
      const candidate = bestCandidate(mask, width, height)
      if (
        candidate &&
        run.length > 0 &&
        sameQuad(run[run.length - 1].corners, candidate.corners, tolerance)
      ) {
        run = [...run, candidate]
      } else {
        consider()
        run = candidate ? [candidate] : []
      }
    }
    consider()
  }
  if (!best) return null
  const { run } = best as { run: Candidate[] }
  const middle = run[Math.floor(run.length / 2)]
  const [topLeft, topRight, bottomRight, bottomLeft] = expandQuad(
    middle.corners,
    OUTWARD_OFFSET * Math.max(width, height),
    width,
    height,
  )
  return {
    corners: { topLeft, topRight, bottomRight, bottomLeft },
    // 0.55 is where the app stops asking the user to double-check.
    confidence: Math.min(
      1,
      0.55 +
        0.25 *
          ((middle.rectangularity - MIN_RECTANGULARITY) /
            (1 - MIN_RECTANGULARITY)) +
        0.02 * (run.length - MIN_STABLE_RUN),
    ),
  }
}
