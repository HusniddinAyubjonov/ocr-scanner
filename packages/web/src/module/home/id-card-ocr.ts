import { createWorker, OEM, PSM } from "tesseract.js"
import type { Page } from "tesseract.js"
import { extractCleanText } from "./home.utils"
import { extractIdCardFields, isPlausibleName } from "./id-card.utils"
import { isEnglishLabelText, mergeEnglishLabels } from "./id-card-language"
import { recognizeBackZones } from "./id-card-back-zones"
import { mrzLineBoxes, parseMrzText } from "./id-card-mrz"
import { bottomRegion, locateMrz } from "./mrz-locator"
import type { Region } from "./mrz-locator"
import type { MrzResult } from "./id-card-mrz"
import { buildNameEvidence, NAME_FIELDS, toOcrLines } from "./id-card-names"
import type { NameEvidence } from "./id-card-names"
import {
  extractLayoutFields,
  mergeRecognizedFields,
} from "./id-card-recognition"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import { recognizeFrontZones } from "./id-card-zones"
import type { ZoneReadings } from "./id-card-zones"
import type {
  OcrResult,
  PreprocessingVariant,
  ProcessingImage,
} from "./scanner.types"

// One model per script. The Tajik model only knows Cyrillic: asked to read
// Latin text it cannot output a single letter (only digits survive a Latin
// whitelist), so the MRZ, the Latin name lines and the letter+digit numbers
// go to the English model, and the Tajik text goes to the Tajik model.
const TAJIK_LANGUAGES = ["tgk"]
const ENGLISH_LANGUAGES = ["eng"]

type OcrCandidate = {
  result: OcrResult
  page: Page
}

export type IdCardOcrOutput = {
  ocrResult: OcrResult
  rawText: string
  mrzText: string
  mrzConfidence: number
  fields: Partial<Record<IdCardFieldKey, RecognizedField>>
  // The three names are resolved across both card sides (Cyrillic on the
  // front, MRZ on the back), so they travel as evidence rather than fields.
  names: NameEvidence
}

type RecognizeIdCardOptions = {
  side?: "front" | "back"
  variants: PreprocessingVariant[]
  onStatus: (message: string, progress: number) => void
  shouldContinue: () => boolean
}

const LABEL_WORDS =
  /насаб|surname|номи|падар|падap|napap|father|^ном\b|^(name|мате|mate|nате|наме)$|birth|таваллуд|санаи|document|рақами|раками|шиноснома|nationality|authority|мақоми|address|нишон|issue|expiry|place\s*of|^sex$|чинс/i

type FieldMap = Partial<Record<IdCardFieldKey, RecognizedField>>

const dropLabelValues = (fields: FieldMap): FieldMap => {
  const cleaned: FieldMap = {}
  for (const key of Object.keys(fields) as IdCardFieldKey[]) {
    const field = fields[key]
    const isName =
      key === "surname" || key === "givenNames" || key === "fatherName"
    if (
      field &&
      !LABEL_WORDS.test(field.value.trim()) &&
      !isEnglishLabelText(field.value) &&
      (!isName || isPlausibleName(field.value))
    )
      cleaned[key] = field
  }
  return cleaned
}

const TEXT_PARSER_CONFIDENCE = 80

const extractTextFields = (text: string): FieldMap => {
  const parsed = extractIdCardFields(text)
  const fields: FieldMap = {}
  for (const key of Object.keys(parsed) as IdCardFieldKey[]) {
    const value = parsed[key].trim()
    if (value && !isEnglishLabelText(value))
      fields[key] = {
        value,
        confidence: TEXT_PARSER_CONFIDENCE,
        source: "layout",
      }
  }
  return fields
}

const candidateScore = (candidate: OcrCandidate): number =>
  candidate.result.confidence +
  Object.keys(extractLayoutFields(candidate.page)).length * 3

type NameFieldKey = (typeof NAME_FIELDS)[number]

const withoutNames = (fields: FieldMap): FieldMap => {
  const rest = { ...fields }
  for (const key of NAME_FIELDS) delete rest[key]
  return rest
}

const onlyNames = (fields: FieldMap): Partial<Record<NameFieldKey, RecognizedField>> => {
  const names: Partial<Record<NameFieldKey, RecognizedField>> = {}
  for (const key of NAME_FIELDS) {
    const field = fields[key]
    if (field) names[key] = field
  }
  return names
}

const imagePixels = async (image: ProcessingImage): Promise<ImageData> => {
  const bitmap = await createImageBitmap(image.blob)
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("Canvas недоступен для поиска MRZ.")
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

// Where to read the MRZ: the block found in the picture itself, then the
// bottom of the picture as before. Any variant that shows the block will do,
// since all variants are the same size.
const mrzAreas = async (
  variants: PreprocessingVariant[],
  fallback: Region,
): Promise<Region[]> => {
  for (const variant of variants) {
    const found = locateMrz(
      (await imagePixels(variant.image)).data,
      variant.image.width,
      variant.image.height,
    )
    if (found) return [found, fallback]
  }
  return [fallback]
}

const mrzPageScore = (page: Page, mrz: MrzResult | null): number =>
  (mrz?.score ?? 0) * 10 + page.confidence

export const recognizeIdCard = async ({
  side,
  variants,
  onStatus,
  shouldContinue,
}: RecognizeIdCardOptions): Promise<IdCardOcrOutput> => {
  if (variants.length === 0)
    throw new Error("Нет подготовленных изображений для OCR.")
  // Both models must load; if one fails, the other must not be left running.
  const created = await Promise.allSettled([
    createWorker(TAJIK_LANGUAGES, OEM.LSTM_ONLY, {
      logger: (message) => {
        if (shouldContinue() && message.status === "recognizing text") {
          onStatus("Распознавание текста", Math.round(message.progress * 100))
        }
      },
    }),
    createWorker(ENGLISH_LANGUAGES, OEM.LSTM_ONLY),
  ])
  const [tajikResult, englishResult] = created
  if (tajikResult.status === "rejected" || englishResult.status === "rejected") {
    await Promise.allSettled(
      created.map((result) =>
        result.status === "fulfilled" ? result.value.terminate() : undefined,
      ),
    )
    throw tajikResult.status === "rejected"
      ? tajikResult.reason
      : (englishResult as PromiseRejectedResult).reason
  }
  const tajikWorker = tajikResult.value
  const englishWorker = englishResult.value
  try {
    await tajikWorker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    })
    const candidates: OcrCandidate[] = []
    for (const variant of variants) {
      if (!shouldContinue()) throw new Error("OCR отменён.")
      onStatus(`OCR: ${variant.label}`, 0)
      await tajikWorker.setParameters({
        tessedit_pageseg_mode:
          variant.id === "threshold" ? PSM.AUTO : PSM.SPARSE_TEXT,
      })
      const recognition = await tajikWorker.recognize(
        variant.image.blob,
        {},
        { blocks: true },
      )
      candidates.push({
        result: {
          text: extractCleanText(recognition.data),
          confidence: recognition.data.confidence,
          variantId: variant.id,
        },
        page: recognition.data,
      })
    }
    const bestCandidate = candidates.reduce((best, candidate) =>
      candidateScore(candidate) > candidateScore(best) ? candidate : best,
    )
    const bestVariant =
      variants.find(
        (variant) => variant.id === bestCandidate.result.variantId,
      ) ?? variants[0]

    // The same image read by the English model: it fixes the English half of
    // the bilingual labels and supplies the Latin line under each name. Its
    // boxes line up with the Tajik page's because both read the same pixels.
    if (!shouldContinue()) throw new Error("OCR отменён.")
    onStatus("Распознавание английских подписей", 0)
    await englishWorker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      tessedit_char_whitelist: "",
      preserve_interword_spaces: "1",
    })
    const english = await englishWorker.recognize(
      bestVariant.image.blob,
      {},
      { blocks: true },
    )
    const tajikPage = mergeEnglishLabels(bestCandidate.page, english.data)
    const rawText = extractCleanText(tajikPage)

    onStatus("Отдельное распознавание MRZ", 0)
    await englishWorker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "0",
      user_defined_dpi: "300",
    })
    const mrzVariants = [
      bestVariant,
      ...variants.filter((variant) => variant.id !== bestVariant.id),
    ].slice(0, 2)
    // The front has no MRZ; on the back it is looked for where it really is.
    const areas =
      side === "front"
        ? []
        : await mrzAreas(
            variants,
            bottomRegion(bestVariant.image.width, bestVariant.image.height),
          )
    let bestMrz: { page: Page; parsed: MrzResult | null } | null = null
    for (const [index, variant] of mrzVariants.entries())
      for (const rectangle of areas) {
        // The usual bottom area is only a second opinion on one variant when
        // the block was found directly.
        if (index > 0 && areas.length > 1 && rectangle === areas[1]) continue
        if (!shouldContinue()) throw new Error("OCR отменён.")
        const recognition = await englishWorker.recognize(
          variant.image.blob,
          { rectangle },
          { blocks: true },
        )
        const parsed = parseMrzText(recognition.data.text)
        if (
          !bestMrz ||
          mrzPageScore(recognition.data, parsed) >
            mrzPageScore(bestMrz.page, bestMrz.parsed)
        )
          bestMrz = { page: recognition.data, parsed }
      }
    const mrzPage = bestMrz?.page
    const mrz = bestMrz?.parsed ?? null

    let zones: ZoneReadings = { fields: {}, names: {} }
    if (side === "back") {
      onStatus("Распознавание полей обратной стороны", 0)
      const zoneVariant =
        variants.find((variant) => variant.id === "contrast") ?? bestVariant
      zones = {
        fields: await recognizeBackZones({
          tajikWorker,
          englishWorker,
          image: zoneVariant.image,
          mrzLines: mrzPage ? mrzLineBoxes(mrzPage) : [],
          shouldContinue,
        }),
        names: {},
      }
    }
    if (side === "front") {
      onStatus("Распознавание полей по зонам", 0)
      const zoneVariant =
        variants.find((variant) => variant.id === "contrast") ?? bestVariant
      zones = await recognizeFrontZones({
        tajikWorker,
        englishWorker,
        image: zoneVariant.image,
        tajikPage: bestCandidate.page,
        englishPage: english.data,
        shouldContinue,
      })
    }

    const layoutFields = dropLabelValues(extractLayoutFields(tajikPage))
    const textFields = extractTextFields(rawText)
    return {
      ocrResult: { ...bestCandidate.result, text: rawText },
      rawText,
      mrzText: mrzPage?.text.trim() ?? "",
      mrzConfidence: mrzPage?.confidence ?? 0,
      // Reads of a known place on the card, and the MRZ with its check
      // digits, are validated; what the page-wide parsers guess is not. So
      // the guesses only fill what those leave empty, however confident the
      // guess looks (a stray "of" from a label once beat a real "TJK").
      fields: withoutNames({
        ...mergeRecognizedFields(layoutFields, textFields),
        ...mergeRecognizedFields(zones.fields, mrz?.fields ?? {}),
      }),
      names: buildNameEvidence({
        tajikLines: toOcrLines(tajikPage),
        englishLines: toOcrLines(english.data),
        anchored: zones.names,
        labeled: onlyNames(mergeRecognizedFields(layoutFields, textFields)),
        mrz: mrz?.names ?? {},
      }),
    }
  } finally {
    await Promise.allSettled([tajikWorker.terminate(), englishWorker.terminate()])
  }
}
