// src/lib/api/listings.server.ts
import { createServerFn } from "@tanstack/react-start";

export const getListingsServer = createServerFn({ method: "GET" })
  .handler(async () => {
    // This runs strictly on the server!
    // You can call your FastAPI backend here or directly query your DB.
    const response = await fetch("http://localhost:8080/api/listings");
    return await response.json();
  });