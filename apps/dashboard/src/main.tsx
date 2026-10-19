import React from "react";
import ReactDOM from "react-dom/client";
import { BRAND_NAME_FALLBACK } from "@waapi/shared";
import "./index.css";
import { App } from "./App.js";

document.title = BRAND_NAME_FALLBACK;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
