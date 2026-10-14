import type { StorageAdapter } from "../types/storage";

/** SSR-safe localStorage. Works in both Next.js (SSR) and Electron (always client). */
export const defaultStorage: StorageAdapter = {
  getItem: (k) =>
    typeof window !== "undefined" ? localStorage.getItem(k) : null,
  setItem: (k, v) => {
    if (typeof window !== "undefined") localStorage.setItem(k, v);
  },
  removeItem: (k) => {
    if (typeof window !== "undefined") localStorage.removeItem(k);
  },
};

/** Tab-scoped storage for acknowledgements that must survive a page reload. */
export const defaultSessionStorage: StorageAdapter = {
  getItem: (key) =>
    typeof window !== "undefined" ? window.sessionStorage.getItem(key) : null,
  setItem: (key, value) => {
    if (typeof window !== "undefined") window.sessionStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (typeof window !== "undefined") window.sessionStorage.removeItem(key);
  },
};
