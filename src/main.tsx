import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@/components/ThemeProvider";
import { CitePalette } from "@/views/cite/CitePalette";
import "./index.css";

// The cite palette is a separate small window that loads index.html#cite.
const isCite = window.location.hash === "#cite";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isCite ? (
      <ThemeProvider defaultTheme="system" storageKey="local-lib-theme"><CitePalette /></ThemeProvider>
    ) : (
      <App />
    )}
  </React.StrictMode>
);
