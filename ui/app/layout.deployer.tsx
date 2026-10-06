import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// The Portal Deployer's root layout (built with `npm run build:deployer`).
// Same font, styles and theme boot as the portal's layout.tsx (and the same
// theme key, which ThemeToggle reads); only the title differs.
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Portal Deployer",
  description: "Deploy the Agent Portal to client workspaces.",
};

const BOOT = `(function(){try{
var q=new URLSearchParams(location.search).get('theme');
var v=q||localStorage.getItem('agent-portal-theme');
if(q&&(q==='light'||q==='dark'))localStorage.setItem('agent-portal-theme',q);
if(v==='light'||v==='dark')document.documentElement.setAttribute('data-theme',v);
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
