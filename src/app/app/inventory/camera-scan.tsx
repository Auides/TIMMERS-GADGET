"use client";

import { useEffect, useRef, useState } from "react";
import { isCameraScanningSupported } from "./inventory-ui";

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue?: string }>> };
type DetectorConstructor = new (options?: { formats?: string[] }) => Detector;

export function CameraScanButton({ onScan }: { onScan: (value: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [message, setMessage] = useState("");
  const [open, setOpen] = useState(false);
  const stop = () => { if (timer.current) clearInterval(timer.current); stream.current?.getTracks().forEach((track) => track.stop()); stream.current = null; setOpen(false); };
  useEffect(() => stop, []);
  async function start() {
    if (!isCameraScanningSupported()) { setMessage("Camera scanning is not supported here. Enter the code manually."); return; }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
      setOpen(true); setMessage("");
      setTimeout(async () => {
        if (!video.current || !stream.current) return;
        video.current.srcObject = stream.current; await video.current.play();
        const BarcodeDetector = (window as unknown as { BarcodeDetector: DetectorConstructor }).BarcodeDetector;
        const detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "code_128", "qr_code"] });
        timer.current = setInterval(async () => { const result = await detector.detect(video.current!); const value = result[0]?.rawValue?.trim(); if (value) { onScan(value); stop(); } }, 650);
      }, 0);
    } catch { stop(); setMessage("Camera access was unavailable. Enter the code manually."); }
  }
  return <div className="mt-2"><button type="button" onClick={open ? stop : start} className="app-button-secondary px-3 text-sm">{open ? "Stop camera" : "Scan with camera"}</button>{open ? <video ref={video} className="mt-2 max-h-48 w-full rounded bg-black" muted playsInline /> : null}{message ? <p className="mt-1 text-sm text-slate-600">{message}</p> : null}</div>;
}
