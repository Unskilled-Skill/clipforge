import React from "react";
import ReactDOM from "react-dom/client";
// Fonts ship with the app: it often starts at login before the network is
// up, and "no cloud" means no request to Google on every launch.
import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
