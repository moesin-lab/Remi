"use client";
import { useEffect } from "react";
import { recoverChunk } from "../platform/build-continuity";
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { recoverChunk(error); }, [error]);
  return <html><body><p role="alert">{error.message}</p><button onClick={reset}>Retry</button></body></html>;
}
