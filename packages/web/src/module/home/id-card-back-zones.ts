import { PSM } from "tesseract.js"
import type { Bbox } from "tesseract.js"
import { editDistance } from "./id-card.utils"
import { locateBackZones } from "./id-card-back"
import type { AnchorField, Zone, ZonePart } from "./id-card-anchors"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import { addVote, agreedVotes, cropRect, winner } from "./id-card-zones"
import type { Votes, Worker } from "./id-card-zones"
import type { ProcessingImage } from "./scanner.types"

type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

const CYRILLIC_LETTERS = "АБВГҒДЕЁЖЗИӢЙКҚЛМНОПРСТУӮФХҲЦЧҶШЩЪЫЬЭЮЯ"
const LATIN_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
const DIGITS = "0123456789"
const PUNCTUATION = " ,.-/\\'()№"

const CYRILLIC_TEXT = CYRILLIC_LETTERS + DIGITS + PUNCTUATION

// What each read may contain. Restricting the character set is what keeps
// the model from turning a Cyrillic word into Latin lookalikes or the other
// way round.
const WHITELIST = {
  text: CYRILLIC_TEXT,
  maritalCyrillic: `${CYRILLIC_LETTERS}/`,
  maritalLatin: `${LATIN_LETTERS}/`,
  blood: `${LATIN_LETTERS}${DIGITS}()+-/ `,
  digits: DIGITS,
}

const MARITAL_STATUSES = ["SINGLE", "MARRIED", "DIVORCED", "WIDOWED"]
const TAX_ID_LENGTH = 9

const onlyFrom = (text: string, allowed: string): string =>
  [...text].filter((character) => allowed.includes(character)).join("")

const cleanText = (raw: string, allowed: string): string =>
  onlyFrom(raw.normalize("NFC").toUpperCase(), allowed)
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .join(" ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N})]+$/gu, "")
    .trim()

// Parses one raw read of a back-side zone into the field's value, or null
// when it can't be one. Independent of OCR, so it decides what is kept.
export const parseBackRead = (
  field: AnchorField,
  part: ZonePart,
  raw: string,
): string | null => {
  switch (field) {
    case "address":
    case "authority": {
      const text = cleanText(raw, CYRILLIC_TEXT)
      const letters = (text.match(/\p{L}/gu) ?? []).length
      return letters >= (field === "address" ? 3 : 6) ? text : null
    }
    case "maritalStatus": {
      // Printed "МУҶАРРАД/SINGLE": the Tajik word, a slash, the English one.
      if (part === "cyrillic") {
        const word = onlyFrom(
          raw.normalize("NFC").toUpperCase().split("/")[0],
          CYRILLIC_LETTERS,
        )
        return word.length >= 4 ? word : null
      }
      // The slash is sometimes lost, so the English word is whatever the
      // read ends with.
      const word = onlyFrom(
        (raw.toUpperCase().split("/").pop() ?? "").trim(),
        LATIN_LETTERS,
      )
      return (
        MARITAL_STATUSES.find(
          (status) =>
            word.length >= status.length - 1 &&
            editDistance(word.slice(-status.length), status) <= 1,
        ) ?? null
      )
    }
    case "bloodGroup": {
      const text = raw.toUpperCase().replace(/[^A-Z0-9()+\-/]/g, "")
      if (/^N\/?A$/.test(text)) return "N/A"
      const match = text.match(/^(AB|A|B|O)\(?(I{1,3}|IV)?\)?RH([+-])?$/)
      if (!match) return null
      return `${match[1]}${match[2] ? `(${match[2]})` : ""}Rh${match[3] ?? ""}`
    }
    case "taxId": {
      const digits = raw.replace(/\D/g, "")
      return digits.length === TAX_ID_LENGTH ? digits : null
    }
    default:
      return null
  }
}

const ADDRESS_LINE_FLOOR = 40
const AUTHORITY_FLOOR = 50
const SHAPED_FLOOR = 40
const PADDINGS = [0, 0.12, 0.3]
// A line of text is read at a few margins and the most confident read kept: a
// little extra margin often fixes a letter the tight crop got wrong. A read
// this confident ends the search early.
const TEXT_PADDINGS = [0.12, 0, 0.3]
const CONFIDENT_TEXT_READ = 92
const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, Math.round(value)))

const setup = (worker: Worker, whitelist: string) =>
  worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: whitelist,
    preserve_interword_spaces: "1",
  })

type Read = { value: string; confidence: number }

// First read of a zone, at increasing margins, that parses and is confident
// enough.
const readZone = async (
  bitmap: ImageBitmap,
  worker: Worker,
  zone: Zone,
  floor: number,
): Promise<Read | null> => {
  for (const padding of PADDINGS) {
    const { data } = await worker.recognize(
      cropRect(bitmap, zone.rect, padding),
    )
    const value = parseBackRead(zone.field, zone.part, data.text)
    if (value && data.confidence >= floor)
      return { value, confidence: data.confidence }
  }
  return null
}

const readBestText = async (
  bitmap: ImageBitmap,
  worker: Worker,
  zone: Zone,
  floor: number,
): Promise<Read | null> => {
  let best: Read | null = null
  for (const padding of TEXT_PADDINGS) {
    const { data } = await worker.recognize(
      cropRect(bitmap, zone.rect, padding),
    )
    const value = parseBackRead(zone.field, zone.part, data.text)
    if (!value || data.confidence < floor) continue
    if (!best || data.confidence > best.confidence)
      best = { value, confidence: data.confidence }
    if (best.confidence >= CONFIDENT_TEXT_READ) break
  }
  return best
}

// Digits and shaped values are read from several crops and voted on, since a
// wrong character still passes the shape check.
const readVoted = async (
  bitmap: ImageBitmap,
  worker: Worker,
  zone: Zone,
): Promise<Read | null> => {
  const votes: Votes = new Map()
  for (const padding of PADDINGS) {
    const { data } = await worker.recognize(
      cropRect(bitmap, zone.rect, padding),
    )
    const value = parseBackRead(zone.field, zone.part, data.text)
    if (!value) continue
    addVote(votes, value, data.confidence)
    if (agreedVotes(votes)) break
  }
  // The engine's own confidence is unreliable on short digit strings (it can
  // report 0 for a correct read), so two crops agreeing on a value of the
  // right shape is accepted as it is; a single read must be confident.
  const chosen = winner(votes)
  return chosen && (chosen.count >= 2 || chosen.confidence >= SHAPED_FLOOR)
    ? { value: chosen.value, confidence: chosen.confidence }
    : null
}

const recognized = (value: string, confidence: number): RecognizedField => ({
  value,
  confidence,
  source: "layout",
})

export const recognizeBackZones = async (input: {
  tajikWorker: Worker
  englishWorker: Worker
  image: ProcessingImage
  mrzLines: Bbox[]
  shouldContinue: () => boolean
}): Promise<FieldMap> => {
  const bitmap = await createImageBitmap(input.image.blob)
  try {
    const zones = locateBackZones(input.mrzLines, {
      width: bitmap.width,
      height: bitmap.height,
    })
    const zoneFor = (name: AnchorField, part: ZonePart) =>
      zones.find((zone) => zone.field === name && zone.part === part)
    const fields: FieldMap = {}
    const { tajikWorker, englishWorker, shouldContinue } = input

    // The address wraps onto as many lines as it needs: read line by line
    // until one doesn't hold text.
    await setup(tajikWorker, WHITELIST.text)
    const addressLines: Read[] = []
    for (const zone of zones
      .filter((candidate) => candidate.field === "address")
      .sort((first, second) => (first.line ?? 0) - (second.line ?? 0))) {
      if (!shouldContinue()) break
      const read = await readBestText(
        bitmap,
        tajikWorker,
        zone,
        ADDRESS_LINE_FLOOR,
      )
      if (!read) break
      addressLines.push(read)
    }
    if (addressLines.length > 0)
      fields.address = recognized(
        addressLines.map((line) => line.value).join(", "),
        clamp(
          addressLines.reduce((sum, line) => sum + line.confidence, 0) /
            addressLines.length,
          50,
          90,
        ),
      )

    const authority = zoneFor("authority", "cyrillic")
    if (authority && shouldContinue()) {
      const read = await readBestText(
        bitmap,
        tajikWorker,
        authority,
        AUTHORITY_FLOOR,
      )
      if (read)
        fields.authority = recognized(
          read.value,
          clamp(read.confidence, 50, 90),
        )
    }

    // Marital status: the Tajik word is the value; the English word beside it
    // (one of four) confirms that a status was read at all.
    const maritalCyrillic = zoneFor("maritalStatus", "cyrillic")
    const maritalLatin = zoneFor("maritalStatus", "latin")
    if (maritalCyrillic && maritalLatin && shouldContinue()) {
      await setup(tajikWorker, WHITELIST.maritalCyrillic)
      const cyrillic = await readZone(bitmap, tajikWorker, maritalCyrillic, 0)
      await setup(englishWorker, WHITELIST.maritalLatin)
      const latin = await readZone(bitmap, englishWorker, maritalLatin, 0)
      if (cyrillic)
        fields.maritalStatus = recognized(cyrillic.value, latin ? 90 : 65)
      else if (latin) fields.maritalStatus = recognized(latin.value, 60)
    }

    const blood = zoneFor("bloodGroup", "value")
    if (blood && shouldContinue()) {
      await setup(englishWorker, WHITELIST.blood)
      const read = await readVoted(bitmap, englishWorker, blood)
      if (read)
        fields.bloodGroup = recognized(
          read.value,
          clamp(read.confidence, 86, 97),
        )
    }

    const taxId = zoneFor("taxId", "value")
    if (taxId && shouldContinue()) {
      await setup(englishWorker, WHITELIST.digits)
      const read = await readVoted(bitmap, englishWorker, taxId)
      if (read)
        fields.taxId = recognized(read.value, clamp(read.confidence, 86, 97))
    }
    return fields
  } finally {
    bitmap.close()
  }
}
