import { createWorker, OEM, PSM } from "tesseract.js"
import type { Page } from "tesseract.js"
import { extractCleanText } from "./home.utils"
import { extractIdCardFields, isPlausibleName } from "./id-card.utils"
import { parseMrzText } from "./id-card-mrz"
import type { MrzResult } from "./id-card-mrz"
import {
  extractLayoutFields,
  mergeRecognizedFields,
} from "./id-card-recognition"
import type { IdCardFieldKey, RecognizedField } from "./id-card-recognition"
import { recognizeFrontZones } from "./id-card-zones"
import type { OcrResult, PreprocessingVariant } from "./scanner.types"

// Only the English model for now. It reads the MRZ, the Latin lines and the
// letter+digit numbers; it sees Cyrillic lines only as lookalike Latin, so the
// Tajik text is not extracted (the Tajik model can be added back as a second
// worker, see id-card-names.ts and id-card-language.ts).
const OCR_LANGUAGES = ["eng"]

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
    if (value)
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
  const worker = await createWorker(OCR_LANGUAGES, OEM.LSTM_ONLY, {
    logger: (message) => {
      if (shouldContinue() && message.status === "recognizing text") {
        onStatus("Распознавание текста", Math.round(message.progress * 100))
      }
    },
  })
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SPARSE_TEXT,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    })
    const candidates: OcrCandidate[] = []
    for (const variant of variants) {
      if (!shouldContinue()) throw new Error("OCR отменён.")
      onStatus(`OCR: ${variant.label}`, 0)
      await worker.setParameters({
        tessedit_pageseg_mode:
          variant.id === "threshold" ? PSM.AUTO : PSM.SPARSE_TEXT,
      })
      const recognition = await worker.recognize(
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

    onStatus("Отдельное распознавание MRZ", 0)
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<",
      preserve_interword_spaces: "0",
    })
    const mrzVariants = [
      bestVariant,
      ...variants.filter((variant) => variant.id !== bestVariant.id),
    ].slice(0, 2)
    let bestMrz: { page: Page; parsed: MrzResult | null } | null = null
    for (const variant of mrzVariants) {
      if (!shouldContinue()) throw new Error("OCR отменён.")
      const top = Math.round(variant.image.height * 0.55)
      const recognition = await worker.recognize(
        variant.image.blob,
        {
          rectangle: {
            left: 0,
            top,
            width: variant.image.width,
            height: variant.image.height - top,
          },
        },
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

    let zoneFields: FieldMap = {}
    if (side === "front") {
      onStatus("Распознавание полей по зонам", 0)
      const zoneVariant =
        variants.find((variant) => variant.id === "contrast") ?? bestVariant
      zoneFields = await recognizeFrontZones(
        worker,
        zoneVariant.image,
        shouldContinue,
      )
    }
    return {
      ocrResult: bestCandidate.result,
      rawText: bestCandidate.result.text,
      mrzText: mrzPage?.text.trim() ?? "",
      mrzConfidence: mrzPage?.confidence ?? 0,
      fields: mergeRecognizedFields(
        zoneFields,
        dropLabelValues(extractLayoutFields(bestCandidate.page)),
        extractTextFields(bestCandidate.result.text),
        mrz?.fields ?? {},
      ),
    }
  } finally {
    await worker.terminate()
  }
}
