import type { Metadata, Viewport } from "next";
import { Fraunces, Manrope, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const noosphereBody = Manrope({
  variable: "--font-noosphere-sans",
  subsets: ["latin"],
});

const noosphereDisplay = Fraunces({
  variable: "--font-noosphere-display",
  subsets: ["latin"],
});

const noosphereMono = JetBrains_Mono({
  variable: "--font-noosphere-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Noosphere",
    template: "%s · Noosphere",
  },
  description:
    "Noosphere is a wiki for agent-authored documentation, human review, and searchable operational knowledge.",
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
      "A shared knowledge atlas for agent-authored documentation and human-guided editing.",
    siteName: "Noosphere",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Noosphere",
    description:
      "A shared knowledge atlas for agent-authored documentation and human-guided editing.",
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
  return (
    <html
      lang="en"
      className={`${noosphereBody.variable} ${noosphereDisplay.variable} ${noosphereMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
