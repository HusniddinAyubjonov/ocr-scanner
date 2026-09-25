import { PSM } from "tesseract.js"
import type { Bbox, createWorker, Page } from "tesseract.js"
import { editDistance } from "./id-card.utils"
import { locateZones, pageSegments } from "./id-card-anchors"
import type { AnchorField, Zone, ZonePart } from "./id-card-anchors"
import { NAME_FIELDS } from "./id-card-names"
import type { AnchoredNames, NameField, OcrLine } from "./id-card-names"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import type { ProcessingImage } from "./scanner.types"

type Worker = Awaited<ReturnType<typeof createWorker>>
type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

export type ZoneReadings = { fields: FieldMap; names: AnchoredNames }

type ZoneKind =
  | "cyrillicName"
  | "latinName"
  | "date"
  | "sex"
  | "state"
  | "digits13"
  | "documentNumber"

const CYRILLIC_LETTERS = "АБВГҒДЕЁЖЗИӢЙКҚЛМНОПРСТУӮФХҲЦЧҶШЩЪЫЬЭЮЯ"
const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

const WHITELIST: Record<ZoneKind, string> = {
  cyrillicName: `${CYRILLIC_LETTERS} '-`,
  latinName: `${LATIN_LETTERS} '-`,
  date: "0123456789.",
  sex: "MF3/",
  state: `${LATIN_LETTERS}/`,
  digits13: "0123456789",
  documentNumber: `${LATIN_LETTERS}0123456789`,
}

const TARGET_ZONE_HEIGHT = 110
const MAX_SCALE = 5

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  Q: "0",
  D: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  B: "8",
}

const validDate = (digits: string, min: number, max: number): string | null => {
  if (!/^\d{8}$/.test(digits)) return null
  const day = Number(digits.slice(0, 2))
  const month = Number(digits.slice(2, 4))
  const year = Number(digits.slice(4, 8))
  const date = new Date(year, month - 1, day)
  const real =
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  return real && year >= min && year <= max
    ? `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 8)}`
    : null
}

const CYRILLIC_NAME = new RegExp(
  `^[${CYRILLIC_LETTERS}]{2,}(?:[ '-][${CYRILLIC_LETTERS}]+)*$`,
)
const LATIN_NAME = /^[A-Z]{2,}(?:[ '-][A-Z]+)*$/

const kindOf = (field: AnchorField, part: ZonePart): ZoneKind => {
  if (part === "cyrillic") return "cyrillicName"
  if (part === "latin") return "latinName"
  switch (field) {
    case "sex":
      return "sex"
    case "citizenship":
    case "birthPlace":
      return "state"
    case "nationalIdNumber":
      return "digits13"
    case "documentNumber":
      return "documentNumber"
    default:
      return "date"
  }
}

// A wide zone can pick up a stray mark past the end of the name, which OCR
// turns into a one-letter word; punctuation at either end is noise too.
const cleanName = (value: string): string => {
  const words = value
    .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
    .split(/\s+/)
    .filter(Boolean)
  const kept = words.filter((word) => word.length > 1)
  return (kept.length > 0 ? kept : words).join(" ")
}

const STATE = "TJK"

// Parses one raw read into the field's value, or null when it can't be a
// valid value for that field. Cheap, deterministic and independent of OCR,
// so it is what decides whether a read is kept.
export const parseZoneRead = (
  field: AnchorField,
  part: ZonePart,
  raw: string,
): string | null => {
  const kind = kindOf(field, part)
  const text = raw.normalize("NFC").trim().toUpperCase()
  switch (kind) {
    case "cyrillicName": {
      const name = cleanName(
        text.replace(new RegExp(`[^${CYRILLIC_LETTERS} '-]`, "g"), ""),
      )
      return CYRILLIC_NAME.test(name) ? name : null
    }
    case "latinName": {
      const name = cleanName(text.replace(/[^A-Z '-]/g, ""))
      return LATIN_NAME.test(name) ? name : null
    }
    case "sex": {
      // Printed "З/F" or "М/M": Tajik letter, slash, Latin letter.
      const match = text.replace(/\s+/g, "").match(/([MF])$/)
      return match ? match[1] : null
    }
    case "state": {
      // "ТҶК/TJK": only the Latin half is readable by the English model, and
      // its J is often read as I or lost, so a read one character off snaps.
      const letters = text.replace(/[^A-Z/]/g, "")
      // Without the slash read, the Latin half is the last three letters.
      const latin = letters.includes("/")
        ? (letters.split("/").pop() ?? "")
        : letters.slice(-STATE.length)
      return latin.length >= 2 && editDistance(latin, STATE) <= 1 ? STATE : null
    }
    case "date": {
      const digits = text.replace(/\D/g, "")
      const year = new Date().getFullYear()
      if (field === "birthDate") return validDate(digits, 1900, year)
      if (field === "issueDate") return validDate(digits, 2000, year + 1)
      return validDate(digits, 2000, 2100)
    }
    case "digits13": {
      const digits = text.replace(/\D/g, "")
      return digits.length === 13 ? digits : null
    }
    case "documentNumber": {
      const compact = text.replace(/[^A-Z0-9]/g, "")
      if (!/^[A-Z][A-Z0-9]{8}$/.test(compact)) return null
      const tail = [...compact.slice(1)]
        .map((character) => DIGIT_LOOKALIKES[character] ?? character)
        .join("")
      return /^\d{8}$/.test(tail) ? compact[0] + tail : null
    }
  }
}

const cropRect = (
  bitmap: ImageBitmap,
  rect: Bbox,
  padding: number,
): HTMLCanvasElement => {
  const padY = (rect.y1 - rect.y0) * padding
  const padX = padY
  const x = Math.max(0, Math.round(rect.x0 - padX))
  const y = Math.max(0, Math.round(rect.y0 - padY))
  const width = Math.min(
    bitmap.width - x,
    Math.round(rect.x1 - rect.x0 + padX * 2),
  )
  const height = Math.min(
    bitmap.height - y,
    Math.round(rect.y1 - rect.y0 + padY * 2),
  )
  const scale = Math.max(1, Math.min(MAX_SCALE, TARGET_ZONE_HEIGHT / height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas недоступен для распознавания зон.")
  context.imageSmoothingQuality = "high"
  context.drawImage(
    bitmap,
    x,
    y,
    width,
    height,
    0,
    0,
    canvas.width,
    canvas.height,
  )
  return canvas
}

// Bbox of the whole zone stands in for the line's box, so anything found on
// the page pass in the same place can be recognised as the same line.
const ZONE_CONFIDENCE_FLOOR = 60
// Shape alone (13 digits, a letter and eight digits) is strong evidence, and
// these crops read with lower confidence than dates do.
const SHAPED_CONFIDENCE_FLOOR = 40
const confidenceFloor = (kind: ZoneKind): number =>
  kind === "digits13" || kind === "documentNumber"
    ? SHAPED_CONFIDENCE_FLOOR
    : ZONE_CONFIDENCE_FLOOR
const MAX_ZONES_PER_VALUE = 3
const MAX_NAME_READS = 2
const PADDINGS = [0, 0.12, 0.3]

const isNameField = (field: AnchorField): field is NameField =>
  (NAME_FIELDS as string[]).includes(field)

const groupKey = (zone: Zone): string => `${zone.field}:${zone.part}`

// The Tajik and the English label of one value usually place the same
// rectangle; reading it twice would only cost time.
const DUPLICATE_TOLERANCE = 8

const isDuplicate = (first: Bbox, second: Bbox): boolean =>
  Math.abs(first.x0 - second.x0) <= DUPLICATE_TOLERANCE &&
  Math.abs(first.y0 - second.y0) <= DUPLICATE_TOLERANCE &&
  Math.abs(first.x1 - second.x1) <= DUPLICATE_TOLERANCE &&
  Math.abs(first.y1 - second.y1) <= DUPLICATE_TOLERANCE

// Values validated by shape alone (a sex letter, the state code) carry no
// useful OCR confidence, so they get a fixed one.
const VALIDATED_CONFIDENCE = 85

const confidenceFor = (kind: ZoneKind, ocrConfidence: number): number =>
  kind === "sex" || kind === "state"
    ? VALIDATED_CONFIDENCE
    : Math.min(97, Math.max(86, Math.round(ocrConfidence)))

// Digits are what OCR gets wrong quietly (3 for 5, a dropped 1), and a wrong
// digit still passes every shape check. Numbers and dates are therefore read
// from several crops; a value seen twice wins outright, otherwise the most
// confident read does.
type Votes = Map<string, { count: number; confidence: number }>

const addVote = (votes: Votes, value: string, confidence: number): void => {
  const vote = votes.get(value) ?? { count: 0, confidence: 0 }
  votes.set(value, {
    count: vote.count + 1,
    confidence: Math.max(vote.confidence, confidence),
  })
}

const agreedVotes = (votes: Votes): boolean =>
  [...votes.values()].some((vote) => vote.count >= 2)

const winner = (
  votes: Votes,
): { value: string; confidence: number } | undefined => {
  let best: { value: string; count: number; confidence: number } | undefined
  for (const [value, vote] of votes)
    if (
      !best ||
      vote.count > best.count ||
      (vote.count === best.count && vote.confidence > best.confidence)
    )
      best = { value, ...vote }
  return best
}

const isVoted = (kind: ZoneKind): boolean =>
  kind === "date" || kind === "digits13" || kind === "documentNumber"

const readAnchoredZones = async (
  bitmap: ImageBitmap,
  zones: Zone[],
  workers: { tajik: Worker; english: Worker },
  shouldContinue: () => boolean,
): Promise<ZoneReadings> => {
  const groups = new Map<string, Zone[]>()
  for (const zone of zones) {
    const group = groups.get(groupKey(zone)) ?? []
    if (!group.some((other) => isDuplicate(other.rect, zone.rect)))
      groups.set(groupKey(zone), [...group, zone])
  }
  const readings: ZoneReadings = { fields: {}, names: {} }
  for (const candidates of groups.values()) {
    if (!shouldContinue()) break
    const { field, part } = candidates[0]
    const kind = kindOf(field, part)
    const worker = kind === "cyrillicName" ? workers.tajik : workers.english
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: WHITELIST[kind],
      preserve_interword_spaces: "1",
    })
    const nameReads: OcrLine[] = []
    const votes: Votes = new Map()
    search: for (const zone of candidates.slice(0, MAX_ZONES_PER_VALUE)) {
      for (const padding of PADDINGS) {
        const { data } = await worker.recognize(
          cropRect(bitmap, zone.rect, padding),
        )
        const value = parseZoneRead(field, part, data.text)
        if (!value) continue
        if (isNameField(field)) {
          // Names are judged later by comparing the Cyrillic and Latin reads,
          // so a second, different read is worth having.
          if (!nameReads.some((read) => read.text === value))
            nameReads.push({
              text: value,
              confidence: data.confidence,
              bbox: zone.rect,
            })
          if (nameReads.length >= MAX_NAME_READS) break search
          continue
        }
        if (!isVoted(kind)) {
          // A sex letter or the state code: the shape alone settles it.
          readings.fields[field as IdCardFieldKey] = {
            value,
            confidence: VALIDATED_CONFIDENCE,
            source: "layout",
          }
          break search
        }
        if (data.confidence < confidenceFloor(kind)) continue
        addVote(votes, value, data.confidence)
        if (agreedVotes(votes)) break search
      }
    }
    const chosen = winner(votes)
    if (chosen)
      readings.fields[field as IdCardFieldKey] = {
        value: chosen.value,
        confidence: confidenceFor(kind, chosen.confidence),
        source: "layout",
      }
    if (isNameField(field) && nameReads.length > 0) {
      const entry = readings.names[field] ?? { cyrillic: [], latin: [] }
      entry[part === "cyrillic" ? "cyrillic" : "latin"] = nameReads
      readings.names[field] = entry
    }
  }
  return readings
}

// Fallback for a card whose labels weren't found: fixed rectangles as
// fractions of a corrected image that is exactly the card.
type FixedZone = {
  key: AnchorField
  x: number
  y: number
  w: number
  h: number
}

export const FIXED_ZONES: FixedZone[] = [
  { key: "birthDate", x: 0.585, y: 0.69, w: 0.15, h: 0.055 },
  { key: "issueDate", x: 0.365, y: 0.79, w: 0.135, h: 0.055 },
  { key: "expiryDate", x: 0.585, y: 0.795, w: 0.15, h: 0.055 },
  { key: "nationalIdNumber", x: 0.775, y: 0.8, w: 0.205, h: 0.055 },
  { key: "documentNumber", x: 0.04, y: 0.895, w: 0.25, h: 0.06 },
]

const readFixedZones = async (
  bitmap: ImageBitmap,
  missing: FixedZone[],
  worker: Worker,
  shouldContinue: () => boolean,
): Promise<FieldMap> => {
  const fields: FieldMap = {}
  for (const zone of missing) {
    if (!shouldContinue()) break
    const kind = kindOf(zone.key, "value")
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_LINE,
      tessedit_char_whitelist: WHITELIST[kind],
      preserve_interword_spaces: "1",
    })
    const rect: Bbox = {
      x0: zone.x * bitmap.width,
      y0: zone.y * bitmap.height,
      x1: (zone.x + zone.w) * bitmap.width,
      y1: (zone.y + zone.h) * bitmap.height,
    }
    // A first read of the exact rectangle, then two with extra margin in
    // case the card was corrected a little off its true edges.
    const votes: Votes = new Map()
    for (const padding of [0.1, 0.35, 0.7]) {
      const { data } = await worker.recognize(cropRect(bitmap, rect, padding))
      const value = parseZoneRead(zone.key, "value", data.text)
      if (!value || data.confidence < confidenceFloor(kind)) continue
      addVote(votes, value, data.confidence)
      if (agreedVotes(votes)) break
    }
    const chosen = winner(votes)
    if (chosen)
      fields[zone.key as IdCardFieldKey] = {
        value: chosen.value,
        confidence: confidenceFor(kind, chosen.confidence),
        source: "layout",
      }
  }
  return fields
}

export const recognizeFrontZones = async (input: {
  tajikWorker: Worker
  englishWorker: Worker
  image: ProcessingImage
  tajikPage: Page
  englishPage: Page
  shouldContinue: () => boolean
}): Promise<ZoneReadings> => {
  const bitmap = await createImageBitmap(input.image.blob)
  try {
    const zones = locateZones(
      pageSegments(input.tajikPage),
      pageSegments(input.englishPage),
      { width: bitmap.width, height: bitmap.height },
    )
    const readings = await readAnchoredZones(
      bitmap,
      zones,
      { tajik: input.tajikWorker, english: input.englishWorker },
      input.shouldContinue,
    )
    const missing = FIXED_ZONES.filter(
      (zone) => !readings.fields[zone.key as IdCardFieldKey],
    )
    const fallback = await readFixedZones(
      bitmap,
      missing,
      input.englishWorker,
      input.shouldContinue,
    )
    return { ...readings, fields: { ...fallback, ...readings.fields } }
  } finally {
    bitmap.close()
  }
}
