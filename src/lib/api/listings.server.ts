// src/lib/api/listings.server.ts
import { createServerFn } from "@tanstack/react-start";

export const getListingsServer = createServerFn({ method: "GET" })
  .handler(async () => {
    // This fetches from your FastAPI backend running on port 8080
    const response = await fetch("https://marketplace-system-lf78.onrender.com/api/listings");
    if (!response.ok) throw new Error("Could not fetch inventory");
    return await response.json();
  });