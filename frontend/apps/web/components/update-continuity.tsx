"use client";
import { useEffect, useRef, useState } from "react";
import { useIsMutating, useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@multiremi/core/auth";
import { platformStatusOptions, useContinuityStore } from "@multiremi/core/platform-lifecycle";
import { UpdateBanner } from "@multiremi/views/common/update-banner";
import { checkBuild, canRefresh, recoverChunk } from "../platform/build-continuity";

export function UpdateContinuity() {
  const banner = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = banner.current;
    if (!element) return;
    const measure = () => document.documentElement.style.setProperty("--web-update-banner-height", `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element); measure();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--web-update-banner-height"); };
  }, []);
  const loggedIn = useAuthStore(s => !!s.user);
  const status = useQuery({ ...platformStatusOptions(), enabled: loggedIn });
  const switching = useContinuityStore(s => s.switching);
  const pending = useContinuityStore(s => s.pendingWrites + s.heldSends);
  const mutations = useIsMutating();
  const [updated, setUpdated] = useState(false);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let disposed = false;
    const check = async () => { const drift = await checkBuild(); if (!disposed) setUpdated(drift); };
    void check();
    const timer = setInterval(() => { void check(); setBusy(!canRefresh()); }, 15_000);
    const error = (event: ErrorEvent) => { if (recoverChunk(event.error ?? event.message)) event.preventDefault(); };
    const rejection = (event: PromiseRejectionEvent) => { if (recoverChunk(event.reason)) event.preventDefault(); };
    window.addEventListener("focus", check);
    window.addEventListener("error", error);
    window.addEventListener("unhandledrejection", rejection);
    return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", check); window.removeEventListener("error", error); window.removeEventListener("unhandledrejection", rejection); };
  }, []);
  useEffect(() => {
    if (status.dataUpdatedAt && !status.isFetching && status.data?.maintenance.mode === "normal" && !["switching", "restarting", "verifying", "rolling_back"].includes(status.data?.activeOperation?.status ?? "")) useContinuityStore.setState({ switching: false });
  }, [status.dataUpdatedAt, status.isFetching, status.data?.maintenance.mode, status.data?.activeOperation?.status]);
  const mode = status.data?.maintenance.mode;
  const operationSwitching = ["switching", "restarting", "verifying", "rolling_back"].includes(status.data?.activeOperation?.status ?? "");
  const state = switching || operationSwitching ? "switching" : mode === "draining" ? "draining" : updated ? "updated" : null;
  return <div ref={banner} className="relative z-20"><UpdateBanner state={state} busy={!!pending || !!mutations || busy} drain={status.data?.activeOperation?.progress.drain}
    onRefresh={() => { if (canRefresh() && !mutations) window.location.reload(); }} /></div>;
}
