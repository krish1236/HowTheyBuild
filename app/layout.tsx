import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HowTheyBuild",
  description:
    "Citation-first Q&A for software engineers. Real production stories from engineering blogs, postmortems, and systems papers.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
