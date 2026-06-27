import type { Metadata, Viewport } from "next";
import { Fraunces, Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const noosphereBody = Geist({
  variable: "--font-noosphere-sans",
  subsets: ["latin"],
});

const noosphereDisplay = Fraunces({
  variable: "--font-noosphere-display",
  subsets: ["latin"],
});

const noosphereMono = Geist_Mono({
  variable: "--font-noosphere-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Noosphere",
    template: "%s · Noosphere",
  },
  description:
    "Agent-authored documentation, designed for human browsing and editing.",
  applicationName: "Noosphere",
  keywords: [
    "Noosphere",
    "wiki",
    "agent-authored documentation",
    "knowledge base",
    "internal documentation",
  ],
  openGraph: {
    title: "Noosphere",
    description:
      "Agent-authored documentation, designed for human browsing and editing.",
    siteName: "Noosphere",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Noosphere",
    description:
      "Agent-authored documentation, designed for human browsing and editing.",
  },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f2ea" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1020" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const themeScript = `(() => {
    try {
      const theme = window.localStorage.getItem("noosphere-theme");
      if (theme === "light" || theme === "dark") {
        document.documentElement.dataset.theme = theme;
      } else {
        document.documentElement.removeAttribute("data-theme");
      }
    } catch {}
  })();`;

  return (
    <html
      lang="en"
      className={`${noosphereBody.variable} ${noosphereDisplay.variable} ${noosphereMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
