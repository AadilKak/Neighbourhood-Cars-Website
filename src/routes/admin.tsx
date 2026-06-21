import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, type DragEvent } from "react";
import { Check, Eye, EyeOff, GripVertical, RefreshCw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Inventory Admin" },
      { name: "description", content: "Dealer inventory admin." },
    ],
  }),
  component: AdminPage,
});

const PUBLIC_INVENTORY_API = import.meta.env.VITE_PUBLIC_INVENTORY_API ?? "https://marketplace-system-lf78.onrender.com";
const DEALER_SLUG = import.meta.env.VITE_DEALER_SLUG ?? "neighborhood-used-cars";

function configuredDealerSlug() {
  if (typeof window === "undefined") return DEALER_SLUG;
  const params = new URLSearchParams(window.location.search);
  return params.get("dealer") || DEALER_SLUG;
}

type Listing = {
  id: number;
  title: string;
  price?: string;
  mileage?: string;
  transmission?: string;
  description?: string;
  facebook_source_url?: string;
  is_sold?: boolean;
  needs_enrich?: boolean;
  permanent_photos?: string[];
};

type Draft = Pick<Listing, "title" | "price" | "mileage" | "transmission" | "description" | "facebook_source_url">;

function AdminPage() {
  const dealerSlug = configuredDealerSlug();
  const [key, setKey] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(`dealer-admin-key:${dealerSlug}`) || "";
  });
  const [rows, setRows] = useState<Listing[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({ title: "", price: "", mileage: "", transmission: "", description: "", facebook_source_url: "" });
  const [status, setStatus] = useState("Enter dealer key to load inventory.");
  const [loading, setLoading] = useState(false);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [pendingOrderIds, setPendingOrderIds] = useState<number[] | null>(null);

  const selected = useMemo(() => rows.find((row) => row.id === selectedId) || null, [rows, selectedId]);
  const activeRows = rows.filter((row) => !row.is_sold);
  const soldRows = rows.filter((row) => row.is_sold);

  function endpoint(path = "") {
    return `${PUBLIC_INVENTORY_API}/api/dealers/${encodeURIComponent(dealerSlug)}/admin/listings${path}`;
  }

  function edit(row: Listing) {
    setSelectedId(row.id);
    setDraft({
      title: row.title || "",
      price: row.price || "",
      mileage: row.mileage || "",
      transmission: row.transmission || "",
      description: row.description || "",
      facebook_source_url: row.facebook_source_url || "",
    });
  }

  async function load() {
    if (!key.trim()) {
      setStatus("Enter the dealer key first.");
      return;
    }
    localStorage.setItem(`dealer-admin-key:${dealerSlug}`, key.trim());
    setLoading(true);
    setStatus("Loading inventory...");
    try {
      const res = await fetch(`${endpoint()}?key=${encodeURIComponent(key.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Could not load inventory.");
      setRows(data);
      if (data[0]) edit(data[0]);
      setStatus(`Loaded ${data.filter((row: Listing) => !row.is_sold).length} active / ${data.length} total.`);
    } catch (err: any) {
      setStatus(err.message || "Could not load inventory.");
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!selected) return;
    setLoading(true);
    setStatus("Saving listing...");
    try {
      const res = await fetch(endpoint(`/${selected.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Save failed.");
      setStatus("Listing saved.");
      await load();
    } catch (err: any) {
      setStatus(err.message || "Save failed.");
    } finally {
      setLoading(false);
    }
  }

  async function setSold(row: Listing, isSold: boolean) {
    setLoading(true);
    setStatus(isSold ? "Marking sold..." : "Marking available...");
    try {
      const res = await fetch(endpoint(`/${row.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, is_sold: isSold, needs_enrich: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Update failed.");
      setStatus(isSold ? "Marked sold." : "Marked available.");
      await load();
    } catch (err: any) {
      setStatus(err.message || "Update failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveActiveOrder(nextIds: number[]) {
    const sameOrder = nextIds.join(",") === activeRows.map((item) => item.id).join(",");
    if (sameOrder) return;
    setLoading(true);
    setStatus("Saving display order...");
    try {
      const res = await fetch(endpoint("/reorder"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, listing_ids: nextIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Reorder failed.");
      setStatus("Display order saved.");
      await load();
    } catch (err: any) {
      setStatus(err.message || "Reorder failed.");
    } finally {
      setLoading(false);
      setDraggedId(null);
      setPendingOrderIds(null);
    }
  }

  function dragActiveOver(target: Listing) {
    if (!draggedId || draggedId === target.id) return;
    const current = activeRows;
    const from = current.findIndex((item) => item.id === draggedId);
    const to = current.findIndex((item) => item.id === target.id);
    if (from < 0 || to < 0) return;
    const nextActive = [...current];
    const [moved] = nextActive.splice(from, 1);
    nextActive.splice(to, 0, moved);
    setPendingOrderIds(nextActive.map((item) => item.id));
    setRows([...nextActive, ...soldRows]);
  }

  async function dropActive() {
    if (!draggedId) return;
    await saveActiveOrder(pendingOrderIds || rows.filter((row) => !row.is_sold).map((row) => row.id));
  }

  async function remove(row: Listing) {
    if (!confirm(`Delete ${row.title}?`)) return;
    setLoading(true);
    setStatus("Deleting listing...");
    try {
      const res = await fetch(`${endpoint(`/${row.id}`)}?key=${encodeURIComponent(key)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Delete failed.");
      setStatus("Listing deleted.");
      setSelectedId(null);
      await load();
    } catch (err: any) {
      setStatus(err.message || "Delete failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-100 text-zinc-950">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Dealer Admin</div>
            <h1 className="text-2xl font-black tracking-tight">{dealerSlug}</h1>
          </div>
          <div className="flex w-full gap-2 md:w-auto">
            <Input value={key} onChange={(e) => setKey(e.target.value)} type="password" placeholder="Dealer key" className="bg-white md:w-72" />
            <Button onClick={load} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />Load
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-5 px-5 py-5 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <div className="rounded-md border border-zinc-200 bg-white p-4 text-sm text-zinc-600">{status}</div>
          <InventoryList
            title={`Active (${activeRows.length})`}
            rows={activeRows}
            selectedId={selectedId}
            draggedId={draggedId}
            onEdit={edit}
            onSold={setSold}
            onDelete={remove}
            onDragStart={(row) => setDraggedId(row.id)}
            onDragOver={dragActiveOver}
            onDrop={dropActive}
            onDragEnd={() => {
              setDraggedId(null);
              setPendingOrderIds(null);
            }}
          />
          <InventoryList title={`Sold (${soldRows.length})`} rows={soldRows} selectedId={selectedId} onEdit={edit} onSold={setSold} onDelete={remove} />
        </aside>

        <section>
          <Card className="rounded-md border-zinc-200 bg-white shadow-sm">
            <CardContent className="p-5">
              {!selected ? (
                <div className="py-20 text-center text-zinc-500">Select a listing to edit.</div>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">Editing #{selected.id}</div>
                      <h2 className="mt-1 text-xl font-bold">{selected.title}</h2>
                    </div>
                    <div className="flex gap-2">
                      <Button onClick={save} disabled={loading}><Save className="mr-2 h-4 w-4" />Save</Button>
                      <Button variant="outline" onClick={() => setSold(selected, !selected.is_sold)} disabled={loading}>
                        {selected.is_sold ? <Eye className="mr-2 h-4 w-4" /> : <EyeOff className="mr-2 h-4 w-4" />}
                        {selected.is_sold ? "Available" : "Sold"}
                      </Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="Title" value={draft.title || ""} onChange={(value) => setDraft({ ...draft, title: value })} />
                    <Field label="Price" value={draft.price || ""} onChange={(value) => setDraft({ ...draft, price: value })} />
                    <Field label="Mileage" value={draft.mileage || ""} onChange={(value) => setDraft({ ...draft, mileage: value })} />
                    <Field label="Transmission" value={draft.transmission || ""} onChange={(value) => setDraft({ ...draft, transmission: value })} />
                    <div className="md:col-span-2">
                      <Field label="Facebook URL" value={draft.facebook_source_url || ""} onChange={(value) => setDraft({ ...draft, facebook_source_url: value })} />
                    </div>
                  </div>

                  <label className="block">
                    <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">Description</span>
                    <textarea
                      value={draft.description || ""}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                      className="mt-1 min-h-44 w-full rounded-md border border-zinc-300 bg-white p-3 text-sm outline-none focus:border-zinc-950"
                    />
                  </label>

                  <div className="grid grid-cols-3 gap-3 md:grid-cols-6">
                    {(selected.permanent_photos || []).slice(0, 12).map((url) => (
                      <img key={url} src={url} alt="" className="aspect-square w-full rounded-md object-cover" />
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-bold uppercase tracking-wide text-zinc-500">{label}</span>
      <Input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 bg-white" />
    </label>
  );
}

function InventoryList({
  title,
  rows,
  selectedId,
  draggedId,
  onEdit,
  onSold,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  title: string;
  rows: Listing[];
  selectedId: number | null;
  draggedId?: number | null;
  onEdit: (row: Listing) => void;
  onSold: (row: Listing, isSold: boolean) => void;
  onDelete: (row: Listing) => void;
  onDragStart?: (row: Listing) => void;
  onDragOver?: (row: Listing) => void;
  onDrop?: () => void;
  onDragEnd?: () => void;
}) {
  const canDrag = !!onDragStart;

  function handleDragOver(event: DragEvent<HTMLDivElement>, row: Listing) {
    if (!onDragOver) return;
    event.preventDefault();
    onDragOver(row);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    if (!onDrop) return;
    event.preventDefault();
    onDrop();
  }

  return (
    <div className="rounded-md border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-3 text-sm font-bold">{title}</div>
      <div className="divide-y divide-zinc-100">
        {rows.length === 0 && <div className="p-4 text-sm text-zinc-500">No listings.</div>}
        {rows.map((row) => (
          <div
            key={row.id}
            onDragOver={(event) => handleDragOver(event, row)}
            onDrop={handleDrop}
            onDragEnd={() => onDragEnd?.()}
            className={`p-3 transition-colors ${selectedId === row.id ? "bg-zinc-100" : ""} ${draggedId === row.id ? "opacity-55" : ""}`}
          >
            <div className="flex items-start gap-2">
              <button onClick={() => onEdit(row)} className="block min-w-0 flex-1 text-left">
                <div className="line-clamp-2 text-sm font-semibold">{row.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <span>{row.price || "Call for price"}</span>
                  {row.needs_enrich && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">Needs details</span>}
                  {!row.is_sold && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-800">Live</span>}
                </div>
              </button>
              {canDrag && (
                <span
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    onDragStart?.(row);
                  }}
                  className="inline-flex h-8 w-8 shrink-0 cursor-grab items-center justify-center rounded border border-zinc-200 text-zinc-400 hover:bg-zinc-100 active:cursor-grabbing"
                  aria-label={`Drag ${row.title}`}
                  title="Drag to reorder"
                >
                  <GripVertical className="h-4 w-4" />
                </span>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => onSold(row, !row.is_sold)}>
                <Check className="mr-1 h-3.5 w-3.5" />{row.is_sold ? "Available" : "Sold"}
              </Button>
              <Button size="sm" variant="outline" onClick={() => onDelete(row)} className="border-red-200 text-red-700 hover:bg-red-50">
                <Trash2 className="mr-1 h-3.5 w-3.5" />Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
