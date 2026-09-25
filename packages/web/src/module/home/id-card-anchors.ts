import type { Bbox, Page } from "tesseract.js"

// The front of a Tajikistan ID card is a fixed template: every value is
// printed directly under its bilingual label. A page-wide OCR pass reads the
// labels well but drops or garbles values (a whole name line can go missing),
// so the labels are used as anchors and the small area under each one is read
// again on its own with a character set restricted to what that value can be.
//
// Positions below were measured on a real card whose corners were placed on
// its edges and corrected to 1800x1234. Labels found on a new image are only
// used to register it against that template: one scale and one shift per
// axis, fitted robustly (a label whose box was merged with its neighbour or
// split in two simply doesn't agree with the rest and is outvoted). Every
// value's zone then follows from the fit, even when its own label was not
// read, and a card that is cut off by the frame, or photographed closer or
// further away, still lines up.

type Box = [number, number, number, number]
type Point = [number, number]

export type AnchorField =
  | "surname"
  | "givenNames"
  | "fatherName"
  | "sex"
  | "citizenship"
  | "birthDate"
  | "birthPlace"
  | "issueDate"
  | "expiryDate"
  | "nationalIdNumber"
  | "documentNumber"

// A name is printed twice (Cyrillic, then Latin below it), so it has two
// zones; every other value has one.
export type ZonePart = "cyrillic" | "latin" | "value"

export type Zone = { field: AnchorField; part: ZonePart; rect: Bbox }

export type Segment = { text: string; confidence: number; bbox: Bbox }

type Source = "tajik" | "english"

// A label as read by one model, and where its top-left corner sits on the
// template.
type Anchor = { source: Source; test: (text: string) => boolean; point: Point }

const tajik =
  (pattern: RegExp): Anchor["test"] =>
  (text) =>
    pattern.test(text)
const english =
  (pattern: RegExp, except?: RegExp): Anchor["test"] =>
  (text) =>
    pattern.test(text) && !(except && except.test(text))

const ANCHORS: Anchor[] = [
  { source: "tajik", test: tajik(/насаб/i), point: [665, 306] },
  { source: "english", test: english(/surname/i), point: [665, 306] },
  { source: "tajik", test: tajik(/^ном(?!и)/i), point: [667, 461] },
  {
    source: "english",
    test: english(/name/i, /father|surname/i),
    point: [667, 461],
  },
  { source: "tajik", test: tajik(/падар/i), point: [669, 612] },
  { source: "english", test: english(/father/i), point: [879, 612] },
  { source: "tajik", test: tajik(/санаи\s*таваллуд/i), point: [1080, 760] },
  {
    source: "english",
    test: english(/birth/i, /place/i),
    point: [1081, 791],
  },
  { source: "tajik", test: tajik(/[ҷч]ои\s*та/i), point: [1457, 758] },
  { source: "tajik", test: tajik(/^[ҷч]инс/i), point: [671, 768] },
  { source: "english", test: english(/^sex$/i), point: [669, 798] },
  { source: "tajik", test: tajik(/ша[ҳх]рванд/i), point: [813, 744] },
  { source: "tajik", test: tajik(/яго/i), point: [1459, 878] },
  { source: "english", test: english(/national/i), point: [1458, 910] },
  { source: "tajik", test: tajik(/о[ғг]ози/i), point: [672, 884] },
  { source: "english", test: english(/issue/i), point: [672, 919] },
  { source: "tajik", test: tajik(/ан[ҷч]оми/i), point: [1082, 882] },
  { source: "english", test: english(/expiry/i), point: [1082, 915] },
  { source: "tajik", test: tajik(/ра[қк]ами\s*шиносн/i), point: [93, 1067] },
  { source: "english", test: english(/document/i), point: [402, 1067] },
]

// Where each value is printed, with a little margin, on the same template.
const VALUES: { field: AnchorField; part: ZonePart; box: Box }[] = [
  { field: "surname", part: "cyrillic", box: [655, 333, 1120, 391] },
  { field: "surname", part: "latin", box: [655, 384, 1120, 440] },
  { field: "givenNames", part: "cyrillic", box: [657, 486, 1120, 542] },
  { field: "givenNames", part: "latin", box: [656, 534, 1120, 590] },
  { field: "fatherName", part: "cyrillic", box: [657, 640, 1120, 698] },
  { field: "fatherName", part: "latin", box: [658, 689, 1120, 747] },
  { field: "sex", part: "value", box: [660, 820, 790, 872] },
  { field: "citizenship", part: "value", box: [800, 820, 1010, 872] },
  { field: "birthDate", part: "value", box: [1080, 816, 1330, 870] },
  { field: "birthPlace", part: "value", box: [1450, 815, 1790, 868] },
  { field: "issueDate", part: "value", box: [660, 946, 900, 1000] },
  { field: "expiryDate", part: "value", box: [1078, 942, 1320, 996] },
  { field: "nationalIdNumber", part: "value", box: [1455, 938, 1800, 992] },
  { field: "documentNumber", part: "value", box: [80, 1100, 500, 1165] },
]

// Words of one label ("Санаи таваллуд/") sit close together; two labels in a
// row (the "Ҷинс/  Шаҳрвандӣ/" line) are separated by a much wider gap.
const SEGMENT_GAP = 1
const MIN_WORD_CONFIDENCE = 30

export const pageSegments = (page: Page): Segment[] => {
  const segments: Segment[] = []
  for (const block of page.blocks ?? [])
    for (const paragraph of block.paragraphs)
      for (const line of paragraph.lines) {
        const height = line.bbox.y1 - line.bbox.y0
        const words = line.words
          .filter((word) => word.confidence >= MIN_WORD_CONFIDENCE)
          .sort((first, second) => first.bbox.x0 - second.bbox.x0)
        let group: typeof words = []
        const flush = () => {
          if (group.length === 0) return
          segments.push({
            text: group
              .map((word) => word.text)
              .join(" ")
              .trim(),
            confidence:
              group.reduce((sum, word) => sum + word.confidence, 0) /
              group.length,
            bbox: {
              x0: Math.min(...group.map((word) => word.bbox.x0)),
              y0: Math.min(...group.map((word) => word.bbox.y0)),
              x1: Math.max(...group.map((word) => word.bbox.x1)),
              y1: Math.max(...group.map((word) => word.bbox.y1)),
            },
          })
          group = []
        }
        for (const word of words) {
          const last = group[group.length - 1]
          if (last && word.bbox.x0 - last.bbox.x1 > SEGMENT_GAP * height)
            flush()
          group.push(word)
        }
        flush()
      }
  return segments
}

export type ImageSize = { width: number; height: number }

type AxisFit = { scale: number; shift: number }

const MIN_SCALE = 0.3
const MAX_SCALE = 4
// How far, on the template, a label may sit from where the fit says it should
// be and still count as agreeing with it.
const INLIER_TOLERANCE = 16
// Two labels closer than this along an axis can't tell scale from shift.
const MIN_SPREAD = 100
const MIN_INLIERS = 3

// Least-squares scale and shift over the labels that agree with the fit.
const refit = (pairs: Point[]): AxisFit => {
  const n = pairs.length
  const meanTemplate = pairs.reduce((sum, [template]) => sum + template, 0) / n
  const meanActual = pairs.reduce((sum, [, actual]) => sum + actual, 0) / n
  let covariance = 0
  let variance = 0
  for (const [template, actual] of pairs) {
    covariance += (template - meanTemplate) * (actual - meanActual)
    variance += (template - meanTemplate) ** 2
  }
  const scale = covariance / variance
  return { scale, shift: meanActual - scale * meanTemplate }
}

// Every pair of labels proposes a scale and shift; the proposal most other
// labels agree with wins. Wrongly grouped or misread labels are outliers.
const fitAxis = (pairs: Point[]): AxisFit | null => {
  let best: { pairs: Point[]; error: number } | null = null
  for (let first = 0; first < pairs.length; first += 1)
    for (let second = first + 1; second < pairs.length; second += 1) {
      const spread = pairs[second][0] - pairs[first][0]
      if (Math.abs(spread) < MIN_SPREAD) continue
      const scale = (pairs[second][1] - pairs[first][1]) / spread
      if (scale < MIN_SCALE || scale > MAX_SCALE) continue
      const shift = pairs[first][1] - scale * pairs[first][0]
      const inliers = pairs.filter(
        ([template, actual]) =>
          Math.abs(scale * template + shift - actual) <=
          INLIER_TOLERANCE * scale,
      )
      const error = inliers.reduce(
        (sum, [template, actual]) =>
          sum + Math.abs(scale * template + shift - actual),
        0,
      )
      if (
        !best ||
        inliers.length > best.pairs.length ||
        (inliers.length === best.pairs.length && error < best.error)
      )
        best = { pairs: inliers, error }
    }
  if (!best || best.pairs.length < MIN_INLIERS) return null
  const spreadOk =
    Math.max(...best.pairs.map(([template]) => template)) -
      Math.min(...best.pairs.map(([template]) => template)) >=
    MIN_SPREAD
  if (!spreadOk) return null
  const fit = refit(best.pairs)
  return fit.scale >= MIN_SCALE && fit.scale <= MAX_SCALE ? fit : null
}

export const locateZones = (
  tajikSegments: Segment[],
  englishSegments: Segment[],
  image: ImageSize,
): Zone[] => {
  const matches = ANCHORS.flatMap((anchor) =>
    (anchor.source === "tajik" ? tajikSegments : englishSegments)
      .filter((segment) => anchor.test(segment.text))
      .map((segment) => ({ anchor, segment })),
  )
  const horizontal = fitAxis(
    matches.map(({ anchor, segment }): Point => [
      anchor.point[0],
      segment.bbox.x0,
    ]),
  )
  const vertical = fitAxis(
    matches.map(({ anchor, segment }): Point => [
      anchor.point[1],
      segment.bbox.y0,
    ]),
  )
  if (!horizontal || !vertical) return []
  return VALUES.map(({ field, part, box }): Zone => ({
    field,
    part,
    rect: {
      x0: Math.max(0, horizontal.scale * box[0] + horizontal.shift),
      y0: Math.max(0, vertical.scale * box[1] + vertical.shift),
      x1: Math.min(image.width, horizontal.scale * box[2] + horizontal.shift),
      y1: Math.min(image.height, vertical.scale * box[3] + vertical.shift),
    },
  })).filter(
    (zone) =>
      zone.rect.x1 - zone.rect.x0 > 20 && zone.rect.y1 - zone.rect.y0 > 10,
  )
}
