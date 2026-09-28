import type { Metadata } from "next";
import "./globals.css";
import { ImpersonationBanner } from '@/components/impersonation-banner';

export const metadata: Metadata = {
  title: "Thanda Store",
  description: "Premium Solar Solutions at Thanda Store",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col"><ImpersonationBanner />{children}</body>
    </html>
  );
}
