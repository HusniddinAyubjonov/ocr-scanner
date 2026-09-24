import { parse as parseMrz } from "mrz"
import type { Bbox, Page } from "tesseract.js"
import type { IdCardFields } from "./id-card.utils"

export type IdCardFieldKey = keyof IdCardFields
export type RecognitionSource = "layout" | "mrz"

export type RecognizedField = {
  value: string
  confidence: number
  source: RecognitionSource
}

export type RecognizedIdCard = {
  fields: Partial<Record<IdCardFieldKey, RecognizedField>>
  rawText: string
  mrzText: string
  mrzConfidence: number
}

type SpatialLine = {
  text: string
  confidence: number
  bbox: Bbox
  words: SpatialWord[]
}

type SpatialWord = {
  text: string
  confidence: number
  bbox: Bbox
}

type FieldDefinition = {
  key: IdCardFieldKey
  labels: RegExp[]
  validate: (value: string) => string | null
}

const DATE_PATTERN = /\b\d{2}[./]\d{2}[./]\d{4}\b/
const LABEL_PATTERN =
  /surname|насаб|given names?|ном(?:и падар)?|father|sex|ҷинс|чинс|date of birth|таваллуд|place of birth|nationality|шаҳрванд|citizenship|document(?: id)? no|рақами? шиноснома|id number|national id|authority|мақоми|address|нишон[иӣ]|date of issue|date of expiry|marital|blood group/i

const cleanValue = (value: string): string =>
  value
    .replace(/^[\s:;/|.,-]+|[\s:;/|.,-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
const validateName = (value: string): string | null => {
  const cleaned = cleanValue(value)
  return cleaned.length >= 2 &&
    cleaned.length <= 60 &&
    /^[A-Za-zА-Яа-яЁёӢӣӮӯҚқҒғҲҳҶҷ' -]+$/.test(cleaned)
    ? cleaned
    : null
}
const validateDate = (value: string): string | null => {
  const match = value.match(DATE_PATTERN)
  if (!match) return null
  const [day, month, year] = match[0].split(/[./]/).map(Number)
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? match[0].replaceAll("/", ".")
    : null
}
const validateSex = (value: string): string | null => {
  const normalized = cleanValue(value).toUpperCase()
  if (/^(M|М|МУЖ|MALE)$/.test(normalized)) return "M"
  if (/^(F|Ж|ЗАН|FEMALE)$/.test(normalized)) return "F"
  return null
}
const validateDocumentNumber = (value: string): string | null => {
  const normalized = cleanValue(value).toUpperCase().replace(/\s/g, "")
  return /^[A-Z]{1,3}\d{6,9}$/.test(normalized) ? normalized : null
}
const validateDigits = (value: string): string | null => {
  const normalized = value.replace(/\s/g, "")
  return /^\d{8,14}$/.test(normalized) ? normalized : null
}
const validateCitizenship = (value: string): string | null => {
  const cleaned = cleanValue(value)
  return /^(TJK|TAJIKISTAN|ТОҶИКИСТОН|ТОЧИКИСТОН)$/i.test(cleaned)
    ? cleaned.toUpperCase()
    : null
}
const validateText = (value: string): string | null => {
  const cleaned = cleanValue(value)
  return cleaned.length >= 2 &&
    cleaned.length <= 100 &&
    /[A-Za-zА-Яа-яЁёӢӣӮӯҚқҒғҲҳҶҷ]/.test(cleaned)
    ? cleaned
    : null
}

const FIELD_DEFINITIONS: FieldDefinition[] = [
  {
    key: "surname",
    labels: [/\bsurname\b/i, /\bнасаб\b/i],
    validate: validateName,
  },
  {
    key: "givenNames",
    labels: [/given names?/i, /^ном(?:\s*\/|\s*:)/i],
    validate: validateName,
  },
  {
    key: "fatherName",
    labels: [/father.?s? name/i, /номи падар/i],
    validate: validateName,
  },
  { key: "sex", labels: [/^sex\b/i, /^[ҷч]инс\b/i], validate: validateSex },
  {
    key: "birthDate",
    labels: [/date of birth/i, /санаи таваллуд/i],
    validate: validateDate,
  },
  {
    key: "birthPlace",
    labels: [/place of birth/i, /[ҷч]ои таваллуд/i],
    validate: validateText,
  },
  {
    key: "citizenship",
    labels: [/nationality/i, /citizenship/i, /ша[ҳх]рванд/i],
    validate: validateCitizenship,
  },
  {
    key: "documentNumber",
    labels: [/document(?: id)? no\.?/i, /ра[қк]ами? шиноснома/i],
    validate: validateDocumentNumber,
  },
  {
    key: "personalIdNumber",
    labels: [/\bid number\b/i],
    validate: validateDigits,
  },
  {
    key: "nationalIdNumber",
    labels: [/national id/i, /ра[қк]ами ягона/i],
    validate: validateDigits,
  },
  {
    key: "authority",
    labels: [/\bauthority\b/i, /ма[қк]оми(?: шиносномади[ҳх]анда)?/i],
    validate: validateText,
  },
  {
    key: "address",
    labels: [/\baddress\b/i, /нишон[иӣ]/i],
    validate: validateText,
  },
  {
    key: "issueDate",
    labels: [/date of issue/i, /санаи додан/i],
    validate: validateDate,
  },
  {
    key: "expiryDate",
    labels: [/date of expiry/i, /му[ҳх]лати амал/i],
    validate: validateDate,
  },
  {
    key: "maritalStatus",
    labels: [/marital status/i, /вазъи оилав/i],
    validate: validateText,
  },
  {
    key: "bloodGroup",
    labels: [/blood group/i, /гур[ӯу][ҳх]и хун/i],
    validate: validateText,
  },
]

const pageLines = (page: Page): SpatialLine[] => {
  if (!page.blocks) return []
  return page.blocks
    .flatMap((block) =>
      block.paragraphs.flatMap((paragraph) => paragraph.lines),
    )
    .map((line) => ({
      text: cleanValue(line.text),
      confidence: line.confidence,
      bbox: line.bbox,
      words: line.words
        .map((word) => ({
          text: cleanValue(word.text),
          confidence: word.confidence,
          bbox: word.bbox,
        }))
        .filter((word) => word.text.length > 0),
    }))
    .filter((line) => line.text.length > 0 && line.confidence >= 25)
    .sort(
      (first, second) =>
        first.bbox.y0 - second.bbox.y0 || first.bbox.x0 - second.bbox.x0,
    )
}

const extractInlineValue = (line: SpatialLine, labels: RegExp[]): string => {
  let remainder = line.text
  labels.forEach((label) => {
    remainder = remainder.replace(label, "")
  })
  return cleanValue(remainder)
}

const findLabelBox = (line: SpatialLine, labels: RegExp[]): Bbox => {
  for (let startIndex = 0; startIndex < line.words.length; startIndex += 1) {
    for (
      let endIndex = startIndex;
      endIndex < Math.min(line.words.length, startIndex + 5);
      endIndex += 1
    ) {
      const text = line.words
        .slice(startIndex, endIndex + 1)
        .map((word) => word.text)
        .join(" ")
      if (labels.some((label) => label.test(text))) {
        const matchedWords = line.words.slice(startIndex, endIndex + 1)
        return {
          x0: Math.min(...matchedWords.map((word) => word.bbox.x0)),
          y0: Math.min(...matchedWords.map((word) => word.bbox.y0)),
          x1: Math.max(...matchedWords.map((word) => word.bbox.x1)),
          y1: Math.max(...matchedWords.map((word) => word.bbox.y1)),
        }
      }
    }
  }
  return line.bbox
}

const findValueNearLabel = (
  labelLine: SpatialLine,
  lines: SpatialLine[],
  definition: FieldDefinition,
): RecognizedField | null => {
  const inlineValue = definition.validate(
    extractInlineValue(labelLine, definition.labels),
  )
  if (inlineValue)
    return {
      value: inlineValue,
      confidence: Math.round(labelLine.confidence),
      source: "layout",
    }
  const labelBox = findLabelBox(labelLine, definition.labels)
  const labelHeight = Math.max(1, labelBox.y1 - labelBox.y0)
  const labelCenter = (labelBox.x0 + labelBox.x1) / 2
  const wordCandidates = lines
    .flatMap((line) => line.words)
    .filter((word) => {
      const verticalGap = word.bbox.y0 - labelBox.y1
      const wordCenter = (word.bbox.x0 + word.bbox.x1) / 2
      return (
        verticalGap >= -labelHeight * 0.2 &&
        verticalGap <= labelHeight * 3.5 &&
        Math.abs(wordCenter - labelCenter) <=
          Math.max(labelBox.x1 - labelBox.x0, labelHeight * 3)
      )
    })
    .sort((first, second) => {
      const firstDistance =
        Math.max(0, first.bbox.y0 - labelBox.y1) +
        Math.abs((first.bbox.x0 + first.bbox.x1) / 2 - labelCenter) * 0.25
      const secondDistance =
        Math.max(0, second.bbox.y0 - labelBox.y1) +
        Math.abs((second.bbox.x0 + second.bbox.x1) / 2 - labelCenter) * 0.25
      return firstDistance - secondDistance
    })
  for (const word of wordCandidates) {
    const value = definition.validate(word.text)
    if (value && word.confidence >= 40)
      return {
        value,
        confidence: Math.round(Math.min(labelLine.confidence, word.confidence)),
        source: "layout",
      }
  }
  const candidates = lines
    .filter((candidate) => {
      const verticalGap = candidate.bbox.y0 - labelLine.bbox.y1
      const horizontallyRelated =
        candidate.bbox.x1 >= labelLine.bbox.x0 - labelHeight &&
        candidate.bbox.x0 <= labelLine.bbox.x1 + labelHeight * 5
      return (
        candidate !== labelLine &&
        verticalGap >= -labelHeight * 0.25 &&
        verticalGap <= labelHeight * 3.5 &&
        horizontallyRelated &&
        !LABEL_PATTERN.test(candidate.text)
      )
    })
    .sort((first, second) => {
      const firstDistance =
        Math.max(0, first.bbox.y0 - labelLine.bbox.y1) +
        Math.abs(first.bbox.x0 - labelLine.bbox.x0) * 0.2
      const secondDistance =
        Math.max(0, second.bbox.y0 - labelLine.bbox.y1) +
        Math.abs(second.bbox.x0 - labelLine.bbox.x0) * 0.2
      return firstDistance - secondDistance
    })
  for (const candidate of candidates) {
    const value = definition.validate(candidate.text)
    if (value && candidate.confidence >= 40)
      return {
        value,
        confidence: Math.round(
          Math.min(labelLine.confidence, candidate.confidence),
        ),
        source: "layout",
      }
  }
  return null
}

export const extractLayoutFields = (
  page: Page,
): Partial<Record<IdCardFieldKey, RecognizedField>> => {
  const lines = pageLines(page)
  const fields: Partial<Record<IdCardFieldKey, RecognizedField>> = {}
  for (const definition of FIELD_DEFINITIONS) {
    for (const labelLine of lines) {
      if (!definition.labels.some((label) => label.test(labelLine.text)))
        continue
      const field = findValueNearLabel(labelLine, lines, definition)
      if (
        field &&
        (!fields[definition.key] ||
          field.confidence > fields[definition.key]!.confidence)
      )
        fields[definition.key] = field
    }
  }
  return fields
}

const formatMrzDate = (value: string, expiry: boolean): string | null => {
  if (!/^\d{6}$/.test(value)) return null
  const shortYear = Number(value.slice(0, 2))
  const month = Number(value.slice(2, 4))
  const day = Number(value.slice(4, 6))
  const currentShortYear = new Date().getFullYear() % 100
  const year = expiry
    ? 2000 + shortYear
    : shortYear > currentShortYear
      ? 1900 + shortYear
      : 2000 + shortYear
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`
    : null
}
const MRZ_LINE_LENGTH = 30

// OCR drops or adds filler characters at the end of a line, so lines a
// little short are padded with "<" (the MRZ filler) rather than shifted.
const normalizeMrz = (text: string): string[] =>
  text
    .toUpperCase()
    .split("\n")
    .map((line) => line.replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length >= 26 && line.length <= 34)
    .map((line) => line.slice(0, MRZ_LINE_LENGTH).padEnd(MRZ_LINE_LENGTH, "<"))

const DIGIT_LOOKALIKES: Record<string, string> = {
  O: "0",
  D: "0",
  Q: "0",
  I: "1",
  L: "1",
  Z: "2",
  S: "5",
  G: "6",
  B: "8",
}

// Positions that must be digits by the TD1 layout: line 1 = document number
// tail + its check digit; line 2 = birth date, its check digit, expiry date
// and its check digit. Letters there are misread digits.
const fixDigitPositions = (line: string, from: number, to: number): string =>
  [...line]
    .map((character, index) =>
      index >= from && index <= to ? (DIGIT_LOOKALIKES[character] ?? character) : character,
    )
    .join("")

const repairMrzLines = (lines: string[]): string[] => [
  fixDigitPositions(lines[0], 6, 14),
  fixDigitPositions(fixDigitPositions(lines[1], 0, 6), 8, 14),
  lines[2],
]

const MRZ_FALLBACK_NAME = /^[A-Z][A-Z -]{1,}$/

export const extractMrzFields = (
  mrzText: string,
  confidence: number,
): Partial<Record<IdCardFieldKey, RecognizedField>> => {
  const lines = normalizeMrz(mrzText)
  if (lines.length < 3) return {}
  let result: ReturnType<typeof parseMrz>
  try {
    result = parseMrz(repairMrzLines(lines.slice(-3)), { autocorrect: true })
  } catch {
    return {}
  }
  const valid = (name: string): boolean =>
    result.details.some((detail) => detail.field === name && detail.valid)
  const documentOk = valid("documentNumberCheckDigit")
  const birthOk = valid("birthDateCheckDigit")
  const expiryOk = valid("expirationDateCheckDigit")
  // Check digits are the only proof a read is correct; with fewer than two
  // passing, the lines are too damaged to trust any field.
  if ([documentOk, birthOk, expiryOk].filter(Boolean).length < 2) return {}
  const safeConfidence = Math.round(Math.max(0, Math.min(100, confidence)))
  const fields: Partial<Record<IdCardFieldKey, RecognizedField>> = {}
  const set = (key: IdCardFieldKey, value: string | null | undefined) => {
    if (value)
      fields[key] = { value, confidence: safeConfidence, source: "mrz" }
  }
  const mrz = result.fields
  if (documentOk && /^[A-Z0-9]{6,9}$/.test(mrz.documentNumber ?? ""))
    set("documentNumber", mrz.documentNumber)
  if (birthOk && mrz.birthDate)
    set("birthDate", formatMrzDate(mrz.birthDate, false))
  if (expiryOk && mrz.expirationDate)
    set("expiryDate", formatMrzDate(mrz.expirationDate, true))
  if (mrz.sex === "male") set("sex", "M")
  if (mrz.sex === "female") set("sex", "F")
  if (/^[A-Z]{3}$/.test(mrz.nationality ?? "")) set("citizenship", mrz.nationality)
  if (MRZ_FALLBACK_NAME.test(mrz.lastName ?? "")) set("surname", mrz.lastName)
  if (MRZ_FALLBACK_NAME.test(mrz.firstName ?? ""))
    set("givenNames", mrz.firstName)
  return fields
}

export const mergeRecognizedFields = (
  ...sources: Partial<Record<IdCardFieldKey, RecognizedField>>[]
): Partial<Record<IdCardFieldKey, RecognizedField>> => {
  const merged: Partial<Record<IdCardFieldKey, RecognizedField>> = {}
  for (const source of sources)
    for (const key of Object.keys(source) as IdCardFieldKey[]) {
      const candidate = source[key]
      if (
        candidate &&
        candidate.confidence >= 35 &&
        (!merged[key] || candidate.confidence > merged[key]!.confidence)
      )
        merged[key] = candidate
    }
  return merged
}
