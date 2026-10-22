import React from "react";
import ReactDOM from "react-dom/client";
import { BRAND_NAME } from "./brand";
import "./index.css";
import { App } from "./App";

document.title = BRAND_NAME;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
