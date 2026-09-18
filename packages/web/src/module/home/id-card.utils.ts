export type IdCardFields = {
  surname: string
  givenNames: string
  fatherName: string
  sex: string
  birthDate: string
  birthPlace: string
  documentNumber: string
  issueDate: string
  expiryDate: string
  maritalStatus: string
  bloodGroup: string
}

export const EMPTY_ID_CARD_FIELDS: IdCardFields = {
  surname: "",
  givenNames: "",
  fatherName: "",
  sex: "",
  birthDate: "",
  birthPlace: "",
  documentNumber: "",
  issueDate: "",
  expiryDate: "",
  maritalStatus: "",
  bloodGroup: "",
}

const ID_CARD_MARKERS = /шиноснома|identity\s*card|republic\s*of\s*tajikistan|то[чц]икистон/i
const MRZ_LINE_PATTERN = /^[A-Z0-9<]{20,32}$/
// No trailing "-" here: it's meaningful in real values (e.g. blood group "A(II)Rh-").
const SEPARATOR_TRIM = /^[\s:/.,-]+|[\s:/.,]+$/g

// Every field on the front side is printed as a Cyrillic/English label pair
// ("Номи падар/ Father's name") with the actual value elsewhere on the card —
// stripping BOTH label halves and keeping only genuine leftovers avoids
// mistaking the English translation of a label for real data.
const FIELD_LABELS: Record<
  "fatherName" | "birthPlace" | "issueDate" | "maritalStatus" | "bloodGroup",
  RegExp[]
> = {
  fatherName: [/номи\s*падар/i, /father.?s?\s*name/i],
  birthPlace: [/чои\s*таваллуд/i, /place\s*of\s*birth/i],
  issueDate: [/санаи\s*содиршуда/i, /date\s*of\s*issue/i],
  maritalStatus: [/вазъи\s*оилав[^\s/]*/i, /marital\s*status/i],
  bloodGroup: [/гуру[хҳ]и\s*хун[^\s/]*/i, /blood\s*group/i],
}

// Labels the card prints but that we don't extract from front text (surname,
// given name, sex, birth date, document number all come from the MRZ) — kept
// here only to recognize "this is a label line, not a value" while falling
// back to a field's next line.
const NON_EXTRACTED_LABEL_MARKERS =
  /насаб|surname|^ном\b|\bname\b|чинс|\bsex\b|санаи\s*таваллуд|date\s*of\s*birth|рак[а]?ми?\s*шиноснома|document\s*(id\s*)?no/i

const isKnownLabelLine = (line: string): boolean =>
  NON_EXTRACTED_LABEL_MARKERS.test(line) ||
  Object.values(FIELD_LABELS)
    .flat()
    .some((pattern) => pattern.test(line))

const findMrzLines = (lines: string[]): string[] =>
  lines
    .map((line) => line.replace(/\s+/g, ""))
    .filter((line) => line.includes("<") && MRZ_LINE_PATTERN.test(line))

export const isIdCardText = (text: string): boolean => {
  const lines = text.split("\n").map((line) => line.trim())
  return ID_CARD_MARKERS.test(text) || findMrzLines(lines).length >= 2
}

const formatMrzDate = (chars: string): string => {
  if (!/^\d{6}$/.test(chars)) {
    return ""
  }

  const yy = Number.parseInt(chars.slice(0, 2), 10)
  const mm = chars.slice(2, 4)
  const dd = chars.slice(4, 6)
  const currentYy = new Date().getFullYear() % 100
  const year = yy > currentYy + 1 ? 1900 + yy : 2000 + yy

  return `${dd}.${mm}.${year}`
}

const parseMrz = (lines: string[]): Partial<IdCardFields> => {
  const mrzLines = findMrzLines(lines)

  if (mrzLines.length < 2) {
    return {}
  }

  const [line1, line2, line3] = mrzLines
  const fields: Partial<IdCardFields> = {}

  if (line1) {
    const documentNumber = line1.slice(5, 14).replace(/</g, "")
    if (documentNumber) {
      fields.documentNumber = documentNumber
    }
  }

  if (line2) {
    const birthDate = formatMrzDate(line2.slice(0, 6))
    const sexChar = line2[7]
    const expiryDate = formatMrzDate(line2.slice(8, 14))

    if (birthDate) fields.birthDate = birthDate
    if (sexChar === "M" || sexChar === "F") fields.sex = sexChar
    if (expiryDate) fields.expiryDate = expiryDate
  }

  if (line3) {
    const [surnamePart, restPart = ""] = line3.split("<<")
    const surname = surnamePart.replace(/</g, " ").trim()
    const givenNames = restPart.replace(/</g, " ").trim()

    if (surname) fields.surname = surname
    if (givenNames) fields.givenNames = givenNames
  }

  return fields
}

const extractLabeledField = (lines: string[], labelPatterns: RegExp[]): string => {
  for (let i = 0; i < lines.length; i += 1) {
    const isLabelLine = labelPatterns.some((pattern) => pattern.test(lines[i]))
    if (!isLabelLine) {
      continue
    }

    let remainder = lines[i]
    for (const pattern of labelPatterns) {
      remainder = remainder.replace(pattern, "")
    }
    remainder = remainder.replace(SEPARATOR_TRIM, "").trim()

    if (remainder) {
      return remainder
    }

    const next = lines[i + 1]?.trim()

    if (next && !isKnownLabelLine(next)) {
      return next
    }
  }

  return ""
}

export const extractIdCardFields = (text: string): IdCardFields => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const fromLabels: Partial<IdCardFields> = {
    fatherName: extractLabeledField(lines, FIELD_LABELS.fatherName),
    birthPlace: extractLabeledField(lines, FIELD_LABELS.birthPlace),
    issueDate: extractLabeledField(lines, FIELD_LABELS.issueDate),
    maritalStatus: extractLabeledField(lines, FIELD_LABELS.maritalStatus),
    bloodGroup: extractLabeledField(lines, FIELD_LABELS.bloodGroup),
  }

  const fromMrz = parseMrz(lines)

  const fields = { ...EMPTY_ID_CARD_FIELDS, ...fromLabels, ...fromMrz }

  if (!fields.documentNumber) {
    const standaloneMatch = lines
      .map((line) => line.match(/^[A-ZА-ЯЁ]{1,3}\d{6,9}$/))
      .find(Boolean)

    if (standaloneMatch) {
      fields.documentNumber = standaloneMatch[0]
    }
  }

  return fields
}
