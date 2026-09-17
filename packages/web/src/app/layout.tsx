import type { Metadata } from "next"
import "@/style/global.css"

export const metadata: Metadata = {
  title: "Project",
  description: "Application for ...",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
