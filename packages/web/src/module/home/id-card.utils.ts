export type IdCardFields = {
  surname: string
  givenNames: string
  fatherName: string
  sex: string
  birthDate: string
  birthPlace: string
  address: string
  personalIdNumber: string
  authority: string
  documentNumber: string
  nationalIdNumber: string
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
  address: "",
  personalIdNumber: "",
  authority: "",
  documentNumber: "",
  nationalIdNumber: "",
  issueDate: "",
  expiryDate: "",
  maritalStatus: "",
  bloodGroup: "",
}

const ID_CARD_MARKERS = /шиноснома|identity\s*card|republic\s*of\s*tajikistan|то[чц]икистон/i
const MRZ_LINE_PATTERN = /^[A-Z0-9<]{20,32}$/
const DATE_PATTERN = /\d{1,2}[.\/]\d{1,2}[.\/]\d{2,4}/
// No trailing "-" here: it's meaningful in real values (e.g. blood group "A(II)Rh-").
const SEPARATOR_TRIM = /^[\s:/.,-]+|[\s:/.,]+$/g

// A Cyrillic name printed in caps is always immediately followed by its Latin
// transliteration on the next line (e.g. "АЮБОВ" / "AYUBOV"). That pairing
// survives OCR far better than the printed labels do — on a real scan the
// Cyrillic label "Насаб" itself came back as "Haca6" (Latin/Cyrillic
// lookalikes mixed up), so matching the label text is unreliable. The card
// prints surname, given name, then father's name in that fixed order.
const CYRILLIC_CAPS_WORD = /^[А-ЯЁЎҚҒҲҶӢӮ]{2,}$/
const LATIN_CAPS_WORD = /^[A-Z]{2,}$/

const FIELD_LABELS: Record<
  "fatherName" | "birthPlace" | "authority" | "documentNumber" | "maritalStatus" | "bloodGroup",
  RegExp[]
> = {
  fatherName: [/номи\s*падар/i, /father.?s?\s*name/i],
  birthPlace: [/[чц]ои\s*таваллуд/i, /place\s*of\s*birth/i],
  authority: [/мақоми/i, /\bauthority\b/i],
  documentNumber: [/рак[а]?ми?\s*шиноснома/i, /document\s*(id\s*)?no\.?/i],
  maritalStatus: [/вазъи\s*оилав[^\s/]*/i, /marital\s*status/i],
  bloodGroup: [/гуру[хҳ]и\s*хун[^\s/]*/i, /blood\s*group/i],
}

const PERSONAL_ID_LABEL = /\bid\s*number\b/i
// OCR sometimes clips the leading letter off short words at a crop edge
// ("Address" -> "ddress"), so the leading "A" is optional here.
const ADDRESS_LABEL = /\ba?ddress\b/i

// Anything that reads as a label/header rather than actual data — used to
// know where a multi-line value (like an address) ends.
const LABEL_LINE_MARKERS =
  /насаб|surname|номи\s*падар|father|чинс|\bsex\b|[чц]ои\s*таваллуд|place\s*of\s*birth|рак[а]?ми?\s*шиноснома|document\s*(id\s*)?no|мақоми|authority|date\s*of\s*(birth|issue|expiry)|national\s*id|вазъи\s*оилав|marital\s*status|гуру[хҳ]и\s*хун|blood\s*group|^ном\/|шиноснома|identity\s*card|то[чц]икистон|republic\s*of\s*tajikistan/i

const isKnownLabelLine = (line: string): boolean =>
  LABEL_LINE_MARKERS.test(line) ||
  PERSONAL_ID_LABEL.test(line) ||
  ADDRESS_LABEL.test(line) ||
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

// The MRZ (3-line machine-readable block on the back) is the most reliable
// source when it comes through cleanly, but it's tiny monospaced text and
// often gets mangled beyond recovery — findMrzLines only accepts lines that
// still look like a real MRZ row, so a garbled scan just yields nothing here
// instead of producing garbage.
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

const findNamePairs = (lines: string[]): string[] => {
  const pairs: string[] = []

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (CYRILLIC_CAPS_WORD.test(lines[i]) && LATIN_CAPS_WORD.test(lines[i + 1])) {
      pairs.push(lines[i])
    }
  }

  return pairs
}

// Card prints a header row ("Sex Nationality Date of birth Place of") with
// the actual values on the very next row, space-separated — not a per-field
// label/value line like the rest of the card.
const findRowAfterHeader = (lines: string[], isHeader: (line: string) => boolean): string[] => {
  const headerIndex = lines.findIndex(isHeader)

  if (headerIndex === -1) {
    return []
  }

  const next = lines[headerIndex + 1]

  return next ? next.split(/\s+/).filter(Boolean) : []
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

const extractAddress = (lines: string[]): string => {
  const startIndex = lines.findIndex((line) => ADDRESS_LABEL.test(line))

  if (startIndex === -1) {
    return ""
  }

  const collected: string[] = []

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    if (isKnownLabelLine(lines[i])) {
      break
    }
    collected.push(lines[i])
  }

  return collected.join(", ")
}

// The label line itself is unreliable here (OCR sometimes prepends garbled
// fragments of a neighbouring word), so trust only a clean all-digits next
// line rather than whatever text remains after stripping the label.
const extractPersonalIdNumber = (lines: string[]): string => {
  const labelIndex = lines.findIndex((line) => PERSONAL_ID_LABEL.test(line))

  if (labelIndex === -1) {
    return ""
  }

  const next = lines[labelIndex + 1]?.trim()

  return next && /^\d{6,12}$/.test(next) ? next : ""
}

export const extractIdCardFields = (text: string): IdCardFields => {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  const fromLabels: Partial<IdCardFields> = {
    fatherName: extractLabeledField(lines, FIELD_LABELS.fatherName),
    birthPlace: extractLabeledField(lines, FIELD_LABELS.birthPlace),
    authority: extractLabeledField(lines, FIELD_LABELS.authority),
    documentNumber: extractLabeledField(lines, FIELD_LABELS.documentNumber),
    maritalStatus: extractLabeledField(lines, FIELD_LABELS.maritalStatus),
    bloodGroup: extractLabeledField(lines, FIELD_LABELS.bloodGroup),
    personalIdNumber: extractPersonalIdNumber(lines),
    address: extractAddress(lines),
  }

  const namePairs = findNamePairs(lines)
  if (namePairs[0]) fromLabels.surname = namePairs[0]
  if (namePairs[1]) fromLabels.givenNames = namePairs[1]
  if (namePairs[2]) fromLabels.fatherName = namePairs[2]

  const birthRow = findRowAfterHeader(
    lines,
    (line) => /\bsex\b/i.test(line) && /date\s*of\s*birth/i.test(line),
  )
  const sexToken = birthRow.find((token) => /^[MF]+$/.test(token))
  const birthDateToken = birthRow.find((token) => DATE_PATTERN.test(token))

  if (sexToken) fromLabels.sex = sexToken[0]
  if (birthDateToken) fromLabels.birthDate = birthDateToken.match(DATE_PATTERN)?.[0]

  const validityRow = findRowAfterHeader(
    lines,
    (line) => /date\s*of\s*issue/i.test(line) && /date\s*of\s*expiry/i.test(line),
  )

  if (validityRow[0]) fromLabels.issueDate = validityRow[0]
  if (validityRow[1]) fromLabels.expiryDate = validityRow[1]
  if (validityRow[2]) fromLabels.nationalIdNumber = validityRow[2]

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
