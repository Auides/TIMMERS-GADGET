"use client";
import { useState } from "react";
import { CameraScanButton } from "./camera-scan";
export function SerializedLookupForm({ initialQuery }: { initialQuery: string }) { const [query, setQuery] = useState(initialQuery); return <form className="mt-5"><div className="flex gap-2"><input name="q" value={query} onChange={e=>setQuery(e.target.value)} required aria-label="IMEI, serial, SKU, barcode or product name" className="min-h-11 flex-1 rounded border p-2" placeholder="IMEI, serial, SKU, barcode or product name"/><button className="app-button-primary px-4">Search</button></div><CameraScanButton onScan={setQuery}/></form>; }
