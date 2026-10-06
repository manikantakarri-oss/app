import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font, so the portal needs no request to
// Google at runtime - it has to work inside a locked-down workspace.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Agent Portal",
  description: "Ask your team's AI assistants a question.",
};

// Runs before the page paints, so a viewer who chose Light never sees a flash
// of dark (or the reverse) while React hydrates. Kept tiny and defensive:
// localStorage throws in private windows, and a broken theme must not stop the
// portal from loading. `?theme=light|dark` overrides for one visit,
// which makes a specific appearance easy to share or screenshot. With no saved
// choice the CSS media query follows the OS. A client's brand colours (cached
// by lib/brand.ts after the first visit) are applied here too, so a branded
// portal never flashes the default teal.
const BOOT = `(function(){try{
var q=new URLSearchParams(location.search).get('theme');
var v=q||localStorage.getItem('agent-portal-theme');
if(q&&(q==='light'||q==='dark'))localStorage.setItem('agent-portal-theme',q);
if(v==='light'||v==='dark')document.documentElement.setAttribute('data-theme',v);
var b=localStorage.getItem('agent-portal-brand');
if(b){var st=document.createElement('style');st.id='brand-css';st.textContent=b;document.head.appendChild(st);}
}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
