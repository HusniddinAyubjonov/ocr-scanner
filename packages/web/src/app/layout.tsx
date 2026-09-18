import type { Metadata } from "next"
import "@/style/global.css"

export const metadata: Metadata = {
  title: "Document Scanner + OCR",
  description: "Браузерный сканер документов с исправлением перспективы и OCR",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  )
}
