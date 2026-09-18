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
const SEPARATOR_TRIM = /^[\s:/|.,-]+|[\s:/|.,]+$/g

const CYRILLIC_CAPS_WORD = /^[А-ЯЁЎҚҒҲҶӢӮ]{2,}$/
const LATIN_CAPS_WORD = /^[A-Z]{2,}$/

// MRZ text is always plain Latin+digits, but Tesseract sometimes reads a
// Latin letter as its Cyrillic lookalike (О instead of O, Р instead of P) —
// visually identical glyphs, wrong Unicode block. Coercing them back is safe
// specifically for MRZ lines since no genuine Cyrillic ever belongs there.
const CYRILLIC_TO_LATIN: Record<string, string> = {
  А: "A",
  а: "a",
  В: "B",
  Е: "E",
  е: "e",
  Ѕ: "S",
  ѕ: "s",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  о: "o",
  Р: "P",
  р: "p",
  С: "C",
  с: "c",
  Т: "T",
  Х: "X",
  х: "x",
  У: "Y",
  у: "y",
  І: "I",
  і: "i",
}

const normalizeLookalikes = (value: string): string =>
  value.replace(/[АаВЕеЅѕКМНОоРрСсТХхУуІі]/g, (char) => CYRILLIC_TO_LATIN[char] ?? char)

// Document numbers are always "one letter, then only digits" — Tesseract
// frequently reads a digit 0 as a similar-looking letter (O, D, Q...), so
// any non-digit after the first character is almost certainly a misread
// zero, whichever letter it came out as.
const fixDocumentNumberDigits = (value: string): string => {
  if (value.length < 2) {
    return value
  }

  return normalizeLookalikes(value[0]) + value.slice(1).replace(/[^0-9]/g, "0")
}

const hasEnoughLetters = (text: string): boolean =>
  (text.match(/[A-Za-zА-Яа-яЁёЎўҚқҒғҲҳҶҷӢӣӮӯ]/g) ?? []).length >= 2

// Characters that only ever show up as OCR noise around a label (table
// borders, stray quote marks) — a genuine value on this card never
// contains them. A "/" surrounded by whitespace is the leftover of a
// stripped bilingual label separator; a "/" with no space around it is
// legitimate inline data (e.g. "МУЧАРРАД/SINGLE"), so only the spaced form
// counts as noise.
const HARD_NOISE_CHARACTERS = /[|«»"[\]]/
const SPACED_SLASH = /\s\/|\/\s/

// Rejects OCR noise (stray separators, near-empty fragments) that would
// otherwise be mistaken for a genuine field value.
const looksLikeValue = (text: string): boolean =>
  !HARD_NOISE_CHARACTERS.test(text) && !SPACED_SLASH.test(text) && hasEnoughLetters(text)

const MAX_INLINE_VALUE_LENGTH = 20

// A label line with unrelated OCR noise stuck to both ends (garbage before
// the label, garbage after) still leaves a "remainder" once the label text
// itself is stripped — but a real inline value on this kind of card is
// always short (a number, a word or two), so a long leftover is noise, not
// data, and the next line's value should be trusted instead.
const looksLikeInlineValue = (text: string): boolean =>
  looksLikeValue(text) && text.length <= MAX_INLINE_VALUE_LENGTH

const FIELD_LABELS: Record<
  "fatherName" | "birthPlace" | "authority" | "documentNumber" | "maritalStatus" | "bloodGroup",
  RegExp[]
> = {
  // OCR is inconsistent about the "қ"/"ҳ"/"ӣ" hooks — sometimes keeps them,
  // sometimes flattens to the plain Cyrillic letter — so both spellings are
  // accepted throughout.
  fatherName: [/номи\s*падар/i, /father.?s?\s*name/i],
  birthPlace: [/[чцҷ]ои\s*таваллуд/i, /place\s*of\s*birth/i],
  // "Мақоми шиносномадиханда" is the full Tajik phrase ("issuing
  // authority") — stripping only "Мақоми" left "шиносномадиханда" behind
  // looking exactly like a plausible short value.
  authority: [/ма[кқ]оми(\s*шиносномадиханда)?/i, /\bauthority\b/i],
  documentNumber: [/ра[кқ]ами?\s*шиноснома/i, /document\s*(id\s*)?no\.?/i],
  maritalStatus: [/вазъи\s*оилав[^\s/]*/i, /marital\s*status/i],
  // The word after "гурӯҳи" ("group") varies wildly by OCR pass (хун, кум,
  // ...) — just recognizing "гурӯҳи" itself is enough to treat the line as
  // this label and stop it from bleeding into whatever field comes next.
  bloodGroup: [/гур[ӯу][хҳ]и/i, /blood\s*group/i],
}

// OCR sometimes reads the leading "I" of "ID number" as the digit "1".
const PERSONAL_ID_LABEL = /\b[1i]d\s*number\b/i
// "Нишонӣ" is the Tajik word some card revisions use instead of "Address".
const ADDRESS_LABEL = /нишон[иӣ]|\ba?ddress\b/i
const SURNAME_LABEL = [/насаб/i, /surname/i]
const GIVEN_NAME_LABEL = [/^ном\//i]

const LABEL_LINE_MARKERS =
  /насаб|surname|номи\s*падар|father|чинс|\bsex\b|[чц]ои\s*таваллуд|place\s*of(\s*birth)?|ра[кқ]ами?\s*шиноснома|ра[кқ]ами\s*ягонаи|document\s*(id\s*)?no|ма[кқ]оми|authority|date\s*of\s*(birth|issue|expiry)|national\s*id|вазъи\s*оилав|marital\s*status|гур[ӯу][хҳ]и|blood\s*group|^ном\/|шиноснома|identity\s*card|то[чц]икистон|republic\s*of\s*tajikistan/i

const isKnownLabelLine = (line: string): boolean =>
  LABEL_LINE_MARKERS.test(line) ||
  PERSONAL_ID_LABEL.test(line) ||
  ADDRESS_LABEL.test(line) ||
  Object.values(FIELD_LABELS)
    .flat()
    .some((pattern) => pattern.test(line))

// Strip whitespace (OCR sometimes inserts a stray space mid-line) and coerce
// Cyrillic lookalikes before testing — otherwise a single misread character
// makes an otherwise-valid MRZ line fail the pattern and get discarded.
const findMrzLines = (lines: string[]): string[] =>
  lines
    .map((line) => normalizeLookalikes(line.replace(/\s+/g, "")))
    .filter((line) => line.includes("<") && MRZ_LINE_PATTERN.test(line))

export const isIdCardText = (text: string): boolean => {
  const lines = text.split("\n").map((line) => line.trim())
  return ID_CARD_MARKERS.test(text) || findMrzLines(lines).length >= 2
}

const formatMrzDate = (rawChars: string): string => {
  // Same O/0 misread as document numbers, just inside a date field where
  // every character is guaranteed to be a digit.
  const chars = rawChars.replace(/O/gi, "0")

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
      fields.documentNumber = fixDocumentNumberDigits(documentNumber)
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

// The combined "Sex Nationality Date of birth Place of birth" header row
// contains the English phrase "place of birth" — extractLabeledField must not
// mistake that header for a dedicated birthPlace label, or it falls through
// to the header's own value row (sex + birth date) as if it were the value.
const isBirthRowHeader = (line: string): boolean => {
  const normalized = normalizeLookalikes(line)
  return /\bsex\b/i.test(normalized) && /date\s*of\s*birth/i.test(normalized)
}

const findRowAfterHeader = (lines: string[], isHeader: (line: string) => boolean): string[] => {
  const headerIndex = lines.findIndex(isHeader)

  if (headerIndex === -1) {
    return []
  }

  const next = lines[headerIndex + 1]

  return next ? next.split(/\s+/).filter(Boolean) : []
}

const extractLabeledField = (
  lines: string[],
  labelPatterns: RegExp[],
  options?: { skipIf?: (line: string) => boolean; inlineOnly?: boolean },
): string => {
  for (let i = 0; i < lines.length; i += 1) {
    if (options?.skipIf?.(lines[i])) {
      continue
    }

    const isLabelLine = labelPatterns.some((pattern) => pattern.test(lines[i]))
    if (!isLabelLine) {
      continue
    }

    let remainder = lines[i]
    for (const pattern of labelPatterns) {
      remainder = remainder.replace(pattern, "")
    }
    remainder = remainder.replace(SEPARATOR_TRIM, "").trim()

    if (remainder && looksLikeInlineValue(remainder)) {
      return remainder
    }

    // Blood group in particular has never once had a genuine value on the
    // following line across every real scan seen so far — whatever's there
    // always turns out to belong to some other field (authority, an ID
    // number...). Fields marked inlineOnly stop here instead of guessing.
    if (options?.inlineOnly) {
      continue
    }

    const next = lines[i + 1]?.trim()

    if (next && !isKnownLabelLine(next) && looksLikeValue(next)) {
      return next
    }

    if (next && next.length <= 2 && !isKnownLabelLine(next)) {
      const nextAfter = lines[i + 2]?.trim()

      if (nextAfter && !isKnownLabelLine(nextAfter) && looksLikeValue(nextAfter)) {
        return nextAfter
      }
    }
  }

  return ""
}

const findCapsWordAfterLabel = (lines: string[], labelPatterns: RegExp[]): string => {
  for (let i = 0; i < lines.length; i += 1) {
    if (!labelPatterns.some((pattern) => pattern.test(lines[i]))) {
      continue
    }

    const next = lines[i + 1]?.trim()

    if (next && (CYRILLIC_CAPS_WORD.test(next) || LATIN_CAPS_WORD.test(next))) {
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

    // OCR sometimes merges an unrelated date (e.g. the birth date) onto the
    // same line as an address fragment — strip it so it doesn't pollute the
    // address text; extractIdCardFields picks it up separately as birthDate.
    const cleaned = lines[i].replace(DATE_PATTERN, "").replace(/\s{2,}/g, " ").trim()

    if (cleaned) {
      collected.push(cleaned)
    }
  }

  return collected.join(", ")
}

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
    birthPlace: extractLabeledField(lines, FIELD_LABELS.birthPlace, { skipIf: isBirthRowHeader }),
    authority: extractLabeledField(lines, FIELD_LABELS.authority),
    documentNumber: extractLabeledField(lines, FIELD_LABELS.documentNumber),
    maritalStatus: extractLabeledField(lines, FIELD_LABELS.maritalStatus),
    bloodGroup: extractLabeledField(lines, FIELD_LABELS.bloodGroup, { inlineOnly: true }),
    personalIdNumber: extractPersonalIdNumber(lines),
  }

  fromLabels.address = extractAddress(lines)

  fromLabels.surname = findCapsWordAfterLabel(lines, SURNAME_LABEL)
  fromLabels.givenNames = findCapsWordAfterLabel(lines, GIVEN_NAME_LABEL)

  // A card photographed more than once (e.g. both slots caught the front)
  // repeats the same surname pair later in the text — comparing with "қ"
  // and "к" treated as the same letter keeps that repeat from being
  // mistaken for a different name and filling a still-empty field with it.
  const namesLookSame = (a: string, b: string): boolean =>
    a.toLowerCase().replace(/қ/g, "к") === b.toLowerCase().replace(/қ/g, "к")

  const knownNames = [fromLabels.surname, fromLabels.givenNames, fromLabels.fatherName].filter(
    (name): name is string => Boolean(name),
  )
  const availablePairs = findNamePairs(lines).filter(
    (pair) => !knownNames.some((known) => namesLookSame(known, pair)),
  )

  const missingNameFields = (["surname", "givenNames", "fatherName"] as const).filter(
    (key) => !fromLabels[key],
  )
  missingNameFields.forEach((key, index) => {
    if (availablePairs[index]) {
      fromLabels[key] = availablePairs[index]
    }
  })

  const birthRow = findRowAfterHeader(lines, isBirthRowHeader)
  const sexToken = birthRow.map(normalizeLookalikes).find((token) => /^[MF]+$/.test(token))
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

  if (fromLabels.documentNumber) {
    fromLabels.documentNumber = fixDocumentNumberDigits(fromLabels.documentNumber)
  }

  const fromMrz = parseMrz(lines)

  // A falsy value from a later source must never wipe out a good value an
  // earlier source already found — merge field by field, keeping the first
  // truthy value in priority order (front labels preferred, MRZ as fallback).
  const fields = { ...EMPTY_ID_CARD_FIELDS }
  for (const source of [fromMrz, fromLabels]) {
    for (const key of Object.keys(source) as (keyof IdCardFields)[]) {
      const value = source[key]
      if (value) {
        fields[key] = value
      }
    }
  }

  if (!fields.documentNumber) {
    const standaloneMatch = lines
      .map((line) => line.match(/^[A-ZА-ЯЁ]{1,3}\d{6,9}$/))
      .find(Boolean)

    if (standaloneMatch) {
      fields.documentNumber = fixDocumentNumberDigits(standaloneMatch[0])
    }
  }

  if (!fields.nationalIdNumber) {
    const longNumberMatch = lines.map((line) => line.match(/\b\d{12,14}\b/)).find(Boolean)

    if (longNumberMatch) {
      fields.nationalIdNumber = longNumberMatch[0]
    }
  }

  // The MRZ line carrying it is sometimes too short/garbled to trust
  // (parseMrz then skips it entirely) — fall back to the first date found
  // anywhere in the text that isn't already claimed as the issue/expiry
  // date. A date sharing its line with "сол" ("year") is the address's
  // registration date ("... since 10.01.2018, year") printed as a fixed
  // administrative note, not the birth date, even when nothing else in the
  // text is a better candidate.
  // No \b here: JS regex word boundaries only recognize ASCII word
  // characters, so \b around Cyrillic text silently never matches.
  const REGISTRATION_DATE_MARKER = /сол/i

  if (!fields.birthDate) {
    for (const line of lines) {
      if (REGISTRATION_DATE_MARKER.test(line)) {
        continue
      }

      const match = line.match(DATE_PATTERN)
      const candidate = match?.[0]

      if (candidate && candidate !== fields.issueDate && candidate !== fields.expiryDate) {
        fields.birthDate = candidate
        break
      }
    }
  }

  // When the "Sex ... Date of birth" header itself is too garbled to match,
  // the sex marker still often survives right next to a date on the same
  // value row (e.g. "MM TYKTJK 29.07.2001") — OCR sometimes doubles the
  // letter, and may read it as the Cyrillic М lookalike.
  if (!fields.sex) {
    const rowWithSex = lines
      .map((line) => normalizeLookalikes(line))
      .find((line) => DATE_PATTERN.test(line) && /\b[MF]{1,2}\b/.test(line))

    if (rowWithSex) {
      fields.sex = rowWithSex.match(/\b([MF])\1?\b/)?.[1] ?? ""
    }
  }

  // Same idea for the issue/expiry row: when its header is too garbled to
  // recognize, a line carrying two dates back to back is almost certainly
  // that row printed as "issue expiry [national id]".
  if (!fields.issueDate || !fields.expiryDate) {
    const datesInLine = new RegExp(DATE_PATTERN.source, "g")

    for (const line of lines) {
      const matches = line.match(datesInLine)

      if (matches && matches.length >= 2) {
        if (!fields.issueDate) fields.issueDate = matches[0]
        if (!fields.expiryDate) fields.expiryDate = matches[1]
        break
      }
    }
  }

  // A garbled label run can fuse straight into the value with no separator
  // ("MYYAPPAYSINGLE") — if a known status word is recognizable inside it,
  // that word alone is a cleaner result than the whole fused string. When
  // the label itself is missing entirely, the status word can still show up
  // unlabeled on some other line, so this checks the whole text as a last
  // resort.
  const statusPattern = /married|single|divorced|widowed/i
  const maritalStatusMatch =
    fields.maritalStatus.match(statusPattern) ?? lines.map((line) => line.match(statusPattern)).find(Boolean)

  if (maritalStatusMatch) {
    fields.maritalStatus = maritalStatusMatch[0].toUpperCase()
  }

  return fields
}
