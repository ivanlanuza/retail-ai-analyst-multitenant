// pages/_app.js
import "@/styles/globals.css";
import { Geist, Geist_Mono } from "next/font/google";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function App({ Component, pageProps }) {
  return (
    <div
      className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased min-h-screen bg-neutral-100 text-neutral-900`}
    >
      <Component {...pageProps} />
    </div>
  );
}
