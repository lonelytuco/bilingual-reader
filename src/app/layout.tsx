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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#161513" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" className="h-full" data-theme="system" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("theme");if(t)document.documentElement.dataset.theme=t}catch(e){}` }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
