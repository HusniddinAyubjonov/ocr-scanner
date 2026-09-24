import { PSM } from "tesseract.js"
import type { createWorker } from "tesseract.js"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import type { ProcessingImage } from "./scanner.types"

type Worker = Awaited<ReturnType<typeof createWorker>>
type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

type ZoneKind = "latinName" | "date" | "digits13" | "documentNumber"

// Every Tajikistan ID card has the same layout, so each value sits at the
// same place relative to the card edges. Rectangles are fractions of the
// perspective-corrected card (x, y = top-left; w, h = size). Names are read
// from their Latin transliteration line: it is printed in a plain font and
// recognizes far better than the Cyrillic line above it.
type Zone = {
  key: IdCardFieldKey
  kind: ZoneKind
  x: number
  y: number
  w: number
  h: number
}

export const FRONT_ZONES: Zone[] = [
  { key: "surname", kind: "latinName", x: 0.37, y: 0.318, w: 0.4, h: 0.055 },
  { key: "givenNames", kind: "latinName", x: 0.37, y: 0.445, w: 0.4, h: 0.055 },
  { key: "fatherName", kind: "latinName", x: 0.37, y: 0.577, w: 0.5, h: 0.055 },
  { key: "birthDate", kind: "date", x: 0.585, y: 0.69, w: 0.15, h: 0.055 },
  { key: "issueDate", kind: "date", x: 0.365, y: 0.79, w: 0.135, h: 0.055 },
  { key: "expiryDate", kind: "date", x: 0.585, y: 0.795, w: 0.15, h: 0.055 },
  { key: "nationalIdNumber", kind: "digits13", x: 0.775, y: 0.8, w: 0.205, h: 0.055 },
  { key: "documentNumber", kind: "documentNumber", x: 0.04, y: 0.895, w: 0.25, h: 0.06 },
]

const WHITELIST: Record<ZoneKind, string> = {
  latinName: "ABCDEFGHIJKLMNOPQRSTUVWXYZ '-",
  date: "0123456789.",
  digits13: "0123456789",
  documentNumber: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
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

const cropZone = async (
  bitmap: ImageBitmap,
  zone: Zone,
  padding: number,
): Promise<HTMLCanvasElement> => {
  const x = Math.max(0, Math.round((zone.x - padding) * bitmap.width))
  const y = Math.max(0, Math.round((zone.y - padding * 0.6) * bitmap.height))
  const width = Math.min(
    bitmap.width - x,
    Math.round((zone.w + padding * 2) * bitmap.width),
  )
  const height = Math.min(
    bitmap.height - y,
    Math.round((zone.h + padding * 1.2) * bitmap.height),
  )
  const scale = Math.max(1, Math.min(MAX_SCALE, TARGET_ZONE_HEIGHT / height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const context = canvas.getContext("2d")
  if (!context) throw new Error("Canvas недоступен для распознавания зон.")
  context.imageSmoothingQuality = "high"
  context.drawImage(bitmap, x, y, width, height, 0, 0, canvas.width, canvas.height)
  return canvas
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

const parseZoneText = (zone: Zone, raw: string): string | null => {
  const text = raw.trim().toUpperCase()
  switch (zone.kind) {
    case "latinName": {
      const name = text.replace(/[^A-Z '-]/g, "").replace(/\s+/g, " ").trim()
      return /^[A-Z][A-Z '-]{3,}$/.test(name) ? name : null
    }
    case "date": {
      const digits = text.replace(/\D/g, "")
      return zone.key === "birthDate"
        ? validDate(digits, 1900, new Date().getFullYear())
        : validDate(digits, 2000, 2100)
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

const ZONE_CONFIDENCE_FLOOR = 60

export const recognizeFrontZones = async (
  worker: Worker,
  image: ProcessingImage,
  shouldContinue: () => boolean,
): Promise<FieldMap> => {
  const bitmap = await createImageBitmap(image.blob)
  const fields: FieldMap = {}
  try {
    for (const zone of FRONT_ZONES) {
      if (!shouldContinue()) break
      await worker.setParameters({
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
        tessedit_char_whitelist: WHITELIST[zone.kind],
        preserve_interword_spaces: "1",
      })
      // A first read of the exact rectangle, then one with extra margin in
      // case the card was corrected a little off its true edges.
      for (const padding of [0.006, 0.02, 0.04]) {
        const canvas = await cropZone(bitmap, zone, padding)
        const { data } = await worker.recognize(canvas)
        const value = parseZoneText(zone, data.text)
        if (value && data.confidence >= ZONE_CONFIDENCE_FLOOR) {
          fields[zone.key] = {
            value,
            confidence: Math.min(97, Math.max(86, Math.round(data.confidence))),
            source: "layout",
          }
          break
        }
      }
    }
  } finally {
    bitmap.close()
  }
  return fields
}
