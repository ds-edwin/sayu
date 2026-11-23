import React from "react";
import { createRoot } from "react-dom/client";
import Workspace from "../components/workspace";
import FirebaseSessionProvider from "../components/firebase-session";
import "../app/globals.css";
createRoot(document.getElementById("root")!).render(<FirebaseSessionProvider>{scope => <Workspace key={scope ?? "guest"} scope={scope} />}</FirebaseSessionProvider>);
