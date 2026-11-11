import type { Metadata, Viewport } from "next";
import "./globals.css";
// шрифты для кнопок выбора шрифта
import "../../public/fonts/fonts.css";

export const metadata: Metadata = {
  title: "Две книги",
  description: "Одна книга на двух языках, с синхронизацией позиции",
  appleWebApp: { capable: true, title: "Две книги", statusBarStyle: "default" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f3ec",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
