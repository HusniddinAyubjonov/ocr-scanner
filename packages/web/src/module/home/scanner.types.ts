export type Point = {
  x: number
  y: number
}

export type DocumentCorners = {
  topLeft: Point
  topRight: Point
  bottomRight: Point
  bottomLeft: Point
}

export type ProcessingStage =
  | "idle"
  | "loading"
  | "detecting"
  | "reviewing"
  | "correcting"
  | "deskewing"
  | "preprocessing"
  | "recognizing"
  | "cleaning"
  | "ready"
  | "error"

export type ProcessingStatus = {
  stage: ProcessingStage
  message: string
  progress: number | null
}

export type ProcessingImage = {
  blob: Blob
  url: string
  width: number
  height: number
}

export type PreprocessingVariant = {
  id: "contrast" | "threshold" | "sharpen"
  label: string
  image: ProcessingImage
}

export type OcrResult = {
  text: string
  confidence: number
  variantId: PreprocessingVariant["id"]
}

export type ScannerState = {
  sourceFile: File | null
  originalImage: ProcessingImage | null
  detectedImage: ProcessingImage | null
  croppedImage: ProcessingImage | null
  correctedImage: ProcessingImage | null
  preprocessedVariants: PreprocessingVariant[]
  documentCorners: DocumentCorners | null
  detectionConfidence: number
  status: ProcessingStatus
  ocrResult: OcrResult | null
  error: string | null
}

export const INITIAL_SCANNER_STATE: ScannerState = {
  sourceFile: null,
  originalImage: null,
  detectedImage: null,
  croppedImage: null,
  correctedImage: null,
  preprocessedVariants: [],
  documentCorners: null,
  detectionConfidence: 0,
  status: { stage: "idle", message: "Ожидание изображения", progress: null },
  ocrResult: null,
  error: null,
}
