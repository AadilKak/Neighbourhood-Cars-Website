import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState, useEffect } from "react";
import { ChevronLeft, ChevronRight, Search, Phone, MapPin, ShieldCheck, BadgeCheck, Wrench, DollarSign, MessageSquare, Gauge, Settings, Palette, Fuel, FileCheck, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTrigger, DialogTitle } from "@/components/ui/dialog";
import heroImg from "@/assets/hero-cars.jpg";
import nucLogo from "@/assets/nuc-logo.png";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Neighborhood Used Cars - Cheap, Reliable Used Cars in York, PA" },
      { name: "description", content: "Cheap, reliable used cars in York, PA. Freshly inspected, clean titles, runs and drives. Most under $5K. Clear pricing and straightforward deals." },
      { property: "og:title", content: "Neighborhood Used Cars - York, PA" },
      { property: "og:description", content: "Cheap, reliable used cars in York, PA. Most under $5K. Clean titles, inspected, runs and drives." },
    ],
  }),
  component: Index,
});

const FILTERS = ["All", "Sedan", "SUV", "Truck", "Coupe", "Minivan"] as const;

const PUBLIC_INVENTORY_API = import.meta.env.VITE_PUBLIC_INVENTORY_API ?? "https://marketplace-system-lf78.onrender.com";
const DEALER_SLUG = import.meta.env.VITE_DEALER_SLUG ?? "neighborhood-used-cars";
const DEFAULT_DEALER = {
  name: "Neighborhood Used Cars",
  phone: "7174248344",
  address: "559 Hill St, York, PA 17403",
};

function configuredDealerSlug() {
  if (typeof window === "undefined") return DEALER_SLUG;
  const params = new URLSearchParams(window.location.search);
  return params.get("dealer") || DEALER_SLUG;
}

function phoneDigits(phone?: string) {
  return String(phone || "").replace(/\D/g, "");
}

function phoneDisplay(phone?: string) {
  const digits = phoneDigits(phone);
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  return phone || "";
}

function dealerLocation(address?: string) {
  if (!address) return "York, PA";
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(", ") : address;
}

function trackLeadClick(
  dealerSlug: string,
  eventType: "click_text" | "click_call",
  meta: Record<string, unknown> = {},
) {
  if (typeof window === "undefined") return;
  const body = JSON.stringify({
    event_type: eventType,
    page_url: window.location.href,
    vehicle_id: typeof meta.vehicle_id === "number" ? meta.vehicle_id : undefined,
    vehicle_title: typeof meta.vehicle_title === "string" ? meta.vehicle_title : "",
    meta,
  });
  const url = `${PUBLIC_INVENTORY_API}/api/dealers/${encodeURIComponent(dealerSlug)}/analytics/event`;
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

function vehicleDisplayTitle(vehicle: any) {
  return String(vehicle?.display_title || vehicle?.title || "").trim();
}

function Index() {
  const dealerSlug = configuredDealerSlug();
  const { data: dealer } = useQuery({
    queryKey: ["dealer", dealerSlug],
    queryFn: async () => {
      const res = await fetch(`${PUBLIC_INVENTORY_API}/api/dealers/${dealerSlug}`);
      if (!res.ok) throw new Error("Failed to fetch dealer");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    initialData: DEFAULT_DEALER,
  });

  const { data: dbInventory = [], isLoading } = useQuery({
    queryKey: ["listings", dealerSlug],
    queryFn: async () => {
      const res = await fetch(`${PUBLIC_INVENTORY_API}/api/dealers/${dealerSlug}/listings`);
      if (!res.ok) throw new Error("Failed to fetch listings");
      return res.json();
    },
    staleTime: 30_000,       // don't refetch for 30s after a successful load
    refetchOnWindowFocus: false,
  });

  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [query, setQuery] = useState("");
  const dealerData = dealer || DEFAULT_DEALER;
  const dealerName = dealerData.name;
  const locationText = dealerLocation(dealerData.address);
  const dealerPhone = phoneDigits(dealerData.phone);
  const dealerPhoneText = phoneDisplay(dealerData.phone);
  const generalSmsHref = dealerPhone
    ? `sms:${dealerPhone}?&body=${encodeURIComponent("Hi, I'm interested in a used car. What do you have available?")}`
    : "#inventory";

  // Fix the reload-jumps-to-bottom glitch: don't let the browser restore an old
  // scroll position onto async-loaded content; always start at the top.
  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }, []);

  function inferBody(title: string): string {
    const t = title.toLowerCase();

    // 1) Facebook embeds the body style directly in the title, e.g.
    //    "2008 Pontiac Torrent · Sport Utility 4D" or "... · Pickup 4D".
    //    Match those explicit phrases first — they're the most reliable signal.
    if (t.includes("sport utility") || t.includes("suv") || t.includes("crossover")) return "SUV";
    if (t.includes("pickup") || t.includes("truck")) return "Truck";
    if (t.includes("convertible") || t.includes("coupe")) return "Coupe";
    if (t.includes("minivan") || t.includes("mini van") || t.includes("cargo van") || t.includes("passenger van")) return "Minivan";
    if (t.includes("sedan")) return "Sedan";
    if (t.includes("hatchback") || t.includes("wagon")) return "Sedan";

    // 2) No body phrase in the title — fall back to known model names.
    if (/\b(silverado|sierra|f-?150|f-?250|f-?350|ram|tacoma|tundra|ranger|colorado|frontier|titan|dakota|canyon|s-?10)\b/.test(t)) return "Truck";
    if (/\b(explorer|tahoe|suburban|traverse|pilot|highlander|cr-?v|rav-?4|escape|equinox|torrent|freestyle|interceptor|intercepter|4runner|edge|durango|cherokee|wrangler|blazer|bronco|expedition|rogue|murano|pathfinder|sorento|sportage|santa fe|tucson|outback|forester)\b/.test(t)) return "SUV";

    // 3) Last resort: door count. "2D"/"2dr" → coupe, "4D"/"4dr" → sedan.
    if (t.includes("2d") || t.includes("2dr")) return "Coupe";
    if (t.includes("4d") || t.includes("4dr")) return "Sedan";

    return "Sedan";
  }

  const vehicles = useMemo(() => {
    if (!dbInventory) return [];
    return dbInventory
      .filter((v: any) => {
        if (v.is_sold) return false;
        const q = query.trim().toLowerCase();
        const shownTitle = vehicleDisplayTitle(v);
        const matchesQuery = !q || `${shownTitle} ${v.title || ""}`.toLowerCase().includes(q);
        const body = inferBody(shownTitle || v.title || "");
        const matchesFilter = filter === "All" || body === filter;
        return matchesQuery && matchesFilter;
      })
      .sort((a: any, b: any) => {
        const ao = Number(a.display_order || 0);
        const bo = Number(b.display_order || 0);
        if (ao || bo) return ao - bo;
        return Number(b.id || 0) - Number(a.id || 0);
      });
  }, [query, filter, dbInventory]);

  return (
    <div className="page-zoom min-h-screen bg-background pb-20 text-foreground md:pb-0">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/95 shadow-sm backdrop-blur-md">
        <div className="container-app grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-2.5 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:py-3">
          <a href="#" className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <NucLogo size={50} />
            <div className="min-w-0 leading-tight">
              <div className="whitespace-nowrap text-base font-black uppercase tracking-wide text-ink sm:text-lg">{dealerName}</div>
              <div className="hidden text-xs text-muted-foreground sm:block">{locationText}</div>
            </div>
          </a>
          <nav className="hidden items-center justify-center gap-1 text-sm font-semibold md:flex">
            {[
              { href: "#inventory", label: "Inventory" },
              { href: "#about", label: "About" },
              { href: "#reviews", label: "Reviews" },
              { href: "#contact", label: "Contact" },
            ].map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="flex items-center justify-end gap-2">
            <Button asChild size="sm" variant="outline" className="hidden sm:inline-flex">
              <a href={generalSmsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "nav" })}>
                <MessageSquare className="mr-1 h-4 w-4" />Text Us
              </a>
            </Button>
            {dealerPhone && (
              <Button asChild size="sm" className="hidden shadow-sm shadow-primary/20 sm:inline-flex">
                <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "nav" })}>
                  <Phone className="mr-1 h-4 w-4" />Call
                </a>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <img src={heroImg} alt={`${dealerName} used car inventory`} width={1920} height={1088} className="absolute inset-0 h-full w-full object-cover" />
        <div className="absolute inset-0 bg-linear-to-r from-background via-background/90 to-background/40" />
        <div className="absolute inset-0 bg-linear-to-t from-background via-transparent to-transparent" />
        <div className="pointer-events-none absolute -left-32 top-1/3 h-72 w-72 rounded-full bg-primary/20 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-6 py-24 md:py-32">
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            <BadgeCheck className="h-3.5 w-3.5" /> {dealerName}
          </span>
          <h1 className="mt-5 max-w-2xl text-4xl font-extrabold tracking-tight md:text-6xl">
            Current used car inventory.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted-foreground">
            Cheap, reliable used cars in York, PA. Freshly inspected. Clean titles. Runs and drives. Most under $5K. Come test drive.
          </p>

          <div className="mt-8 flex max-w-xl flex-col gap-3 sm:flex-row">
            <Button size="lg" asChild className="h-12 shadow-md shadow-primary/25">
              <a href={generalSmsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "hero" })}><MessageSquare className="mr-2 h-4 w-4" />Text What You Need</a>
            </Button>
            {dealerPhone && (
              <Button size="lg" variant="outline" asChild className="h-12 bg-background/80">
                <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "hero" })}><Phone className="mr-2 h-4 w-4" />Call {dealerPhoneText}</a>
              </Button>
            )}
          </div>

          <div className="mt-4 flex max-w-xl flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-lg sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by year, make, or model…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-11 pl-9"
              />
            </div>
            <Button asChild><a href="#inventory">Browse Inventory</a></Button>
          </div>

          <div className="mt-10 flex max-w-xl flex-wrap gap-3 text-sm">
            {[
              { k: "<$5K", v: "Most cars" },
              { k: locationText, v: "Local lot" },
              { k: "Inspected", v: "Every car" },
              { k: "Clear", v: "Straightforward deals" },
            ].map((s) => (
              <div key={s.v} className="rounded-lg border border-border bg-background/70 px-4 py-3 backdrop-blur">
                <div className="text-xl font-bold text-primary">{s.k}</div>
                <div className="text-muted-foreground">{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="border-y border-border bg-surface">
        <div className="container-app grid grid-cols-2 gap-3 py-7 md:grid-cols-4 md:gap-4">
          {[
            { icon: DollarSign, label: "Most Cars Under $5K" },
            { icon: BadgeCheck, label: "Clean Titles" },
            { icon: ShieldCheck, label: "Freshly Inspected" },
            { icon: Wrench, label: "Runs and Drives" },
          ].map((f) => (
            <div key={f.label} className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-sm transition-shadow hover:shadow-md">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <f.icon className="h-5 w-5" />
              </span>
              <span className="text-sm font-semibold leading-tight text-ink">{f.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Inventory */}
      <section id="inventory" className="container-app py-16 md:py-20">
        <div className="flex flex-col items-start justify-between gap-5 md:flex-row md:items-end">
          <div>
            <span className="eyebrow">On the lot now</span>
            <h2 className="section-rule mt-2 text-3xl font-bold tracking-tight text-ink md:text-4xl">Current Inventory</h2>
            <p className="mt-2 text-muted-foreground">Updated regularly — what you see is what's on the lot.</p>
          </div>
          <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
            {FILTERS.map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-full border px-4 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${
                  filter === f
                    ? "border-primary bg-primary text-primary-foreground shadow-sm shadow-primary/30"
                    : "border-border bg-background hover:bg-muted"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="animate-pulse overflow-hidden rounded-xl border border-border bg-card">
                  <div className="aspect-[16/10] bg-muted" />
                  <div className="p-4 space-y-3">
                    <div className="h-4 bg-muted rounded w-3/4" />
                    <div className="h-6 bg-muted rounded w-1/3" />
                    <div className="h-3 bg-muted rounded w-full mt-4" />
                    <div className="h-3 bg-muted rounded w-2/3" />
                    <div className="h-9 bg-muted rounded w-full mt-4" />
                  </div>
                </div>
              ))
            : vehicles.map((v: any) => (
                <VehicleCard key={v.id} vehicle={v} dealerSlug={dealerSlug} dealerPhone={dealerPhone} dealerPhoneDisplay={dealerPhoneText} locationText={locationText} />
              ))
          }
        </div>

        {!isLoading && vehicles.length === 0 && (
          <div className="mt-12 rounded-lg border border-dashed border-border py-16 text-center text-muted-foreground">
            No vehicles match your search. Try a different filter.
          </div>
        )}
      </section>

      {/* About */}
      <section id="about" className="bg-surface py-16 md:py-20">
        <div className="container-app grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <span className="eyebrow">About us</span>
            <h2 className="section-rule mt-2 text-3xl font-bold tracking-tight text-ink md:text-4xl">Cheap cars that actually run</h2>
            <p className="mt-4 text-muted-foreground">
              Small family-run lot in York, PA. We sell cheap cars that actually run. Most under $5K. Every car is inspected and has a clean title.
            </p>
            <p className="mt-4 text-muted-foreground">
              Text, call, or stop by. Tell us what you need and we will point you to cars that fit.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild className="shadow-md shadow-primary/25">
                <a href={generalSmsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "about" })}><MessageSquare className="mr-2 h-4 w-4" />Text Us</a>
              </Button>
              {dealerPhone && (
                <Button variant="outline" asChild>
                  <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "about" })}><Phone className="mr-2 h-4 w-4" />Call {dealerPhoneText}</a>
                </Button>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:gap-4">
            {[
              { k: "<$5K", v: "Most cars" },
              { k: locationText, v: "Local lot" },
              { k: "Inspected", v: "Every car" },
              { k: "Clear", v: "Straightforward deals" },
            ].map((s) => (
              <div key={s.v} className="rounded-lg border border-border bg-card p-4 shadow-sm transition-shadow hover:shadow-md sm:p-6">
                <div className="text-xl font-bold text-primary">{s.k}</div>
                <div className="mt-1 text-sm text-muted-foreground">{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Reviews */}
      <section id="reviews" className="bg-zinc-950 py-16 text-white md:py-20">
        <div className="container-app">
          <div className="mb-10 text-center">
            <div className="mb-4 flex justify-center gap-1.5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Star
                  key={i}
                  className="h-8 w-8 fill-amber-400 text-amber-400 drop-shadow-[0_0_12px_rgba(251,191,36,0.65)] transition-transform hover:-translate-y-1 hover:scale-125"
                  style={{ animation: "star-pop 1.8s ease-in-out infinite", animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
            <span className="text-sm font-semibold uppercase tracking-wider text-primary">Reviews</span>
            <h2 className="mt-1 text-3xl font-bold tracking-tight md:text-4xl">
              What buyers say
            </h2>
            <p className="mt-3 text-zinc-400">Real feedback from local buyers.</p>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {[
              { name: "Adrian", text: "Probably my best experience on marketplace. Sold me a beautiful Infiniti G35x. Had one little problem with the gear shifter. Took it back and he got his mechanic to fix it. Very trustworthy, would definitely buy another car from him." },
              { name: "Lynn", text: "He was very easy to communicate with. The description was exactly what was said. Highly recommend this dealership/seller." },
              { name: "Travis", text: "Very friendly. Great communication. Absolutely went above and beyond. Highly recommend!" },
              { name: "Malcolm", text: "Great guy, definitely recommend doing business with." },
              { name: "Babykilo", text: "This guy is awesome! I highly recommend!" },
              { name: "Andrea", text: "Helped me out. Very nice!" },
            ].map((review) => (
              <div
                key={review.name}
                className="flex min-h-[210px] flex-col rounded-lg border border-white/10 bg-white/[0.04] p-5 shadow-sm transition-all hover:-translate-y-1 hover:border-primary/40 hover:bg-white/[0.06]"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-primary text-lg font-black uppercase text-primary-foreground shadow-md shadow-primary/30">
                    {review.name[0]}
                  </div>
                  <div className="min-w-0 font-bold">{review.name}</div>
                </div>
                <div className="mt-4 flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} className="h-4.5 w-4.5 fill-amber-400 text-amber-400" />
                  ))}
                </div>
                <p className="mt-4 text-sm leading-relaxed text-zinc-300">"{review.text}"</p>
              </div>
            ))}
          </div>
        </div>
        <style>{`
          @keyframes star-pop {
            0%, 100% { transform: translateY(0) scale(1); }
            35% { transform: translateY(-6px) scale(1.18); }
            55% { transform: translateY(0) scale(1); }
          }
        `}</style>
      </section>

      {/* Contact */}
      <section id="contact" className="bg-background py-16 md:py-20">
        <div className="container-app">
          <div className="rounded-2xl border border-border bg-primary p-6 text-primary-foreground shadow-xl md:p-10">
        <div className="grid gap-10 md:grid-cols-3">
          <div>
            <span className="text-sm font-semibold uppercase tracking-wider text-primary-foreground/70">Get in touch</span>
            <h2 className="mt-1 text-3xl font-bold tracking-tight md:text-4xl">Come see us</h2>
            <p className="mt-3 opacity-80">Text or call first, then come by for a test drive.</p>
          </div>
          <div className="space-y-6 md:col-span-2 md:grid md:grid-cols-3 md:gap-6 md:space-y-0">
            <div className="flex flex-col items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-foreground/10">
                <MapPin className="h-5 w-5" />
              </span>
              <div className="font-semibold">Visit</div>
              <div className="text-sm opacity-80">{dealerData.address || locationText}</div>
            </div>
            <div className="flex flex-col items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-foreground/10">
                <Phone className="h-5 w-5" />
              </span>
              <div className="font-semibold">Call</div>
              <div className="text-sm opacity-80">
                {dealerPhone ? <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "contact" })} className="hover:underline block">{dealerPhoneText}</a> : "Use the text button to ask about inventory."}
              </div>
            </div>
            <div className="flex flex-col items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-foreground/10">
                <MessageSquare className="h-5 w-5" />
              </span>
              <div className="font-semibold">Text</div>
              <div className="text-sm opacity-80">
                <a href={generalSmsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "contact" })} className="hover:underline">
                  Ask what is available
                </a>
              </div>
            </div>
          </div>
        </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border bg-surface">
        <div className="container-app flex flex-col items-center justify-between gap-3 py-6 text-sm text-muted-foreground md:flex-row">
          <div>© {new Date().getFullYear()} {dealerName}</div>
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
            <span>{locationText}{dealerPhoneText ? ` · ${dealerPhoneText}` : ""}</span>
            <a href="/admin" className="underline-offset-4 hover:text-primary hover:underline">Admin</a>
          </div>
        </div>
      </footer>

      <div className={`fixed inset-x-0 bottom-0 z-50 grid gap-2 border-t border-border bg-background/95 p-3 shadow-2xl backdrop-blur-md md:hidden ${dealerPhone ? "grid-cols-2" : "grid-cols-1"}`}>
        <Button asChild className="h-11 min-w-0">
          <a href={generalSmsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "mobile_sticky" })}><MessageSquare className="mr-2 h-4 w-4" />Text Us</a>
        </Button>
        {dealerPhone && (
          <Button asChild variant="outline" className="h-11 min-w-0">
            <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "mobile_sticky" })}><Phone className="mr-2 h-4 w-4" />Call</a>
          </Button>
        )}
      </div>
    </div>
  );
}

// Default logo for the reusable dealer site. Swap this asset in a customer fork
// if they want their own branding.
function NucLogo({ size = 40 }: { size?: number }) {
  return (
    <img
      src={nucLogo}
      width={size}
      height={size}
      alt="Dealer logo"
      className="rounded-full object-cover shrink-0"
      style={{ width: size, height: size }}
    />
  );
}

function VehicleCard({
  vehicle: v,
  dealerSlug,
  dealerPhone,
  dealerPhoneDisplay,
  locationText,
}: {
  vehicle: any;
  dealerSlug: string;
  dealerPhone: string;
  dealerPhoneDisplay: string;
  locationText: string;
}) {
  const photos: string[] = v.permanent_photos ?? [];
  const [idx, setIdx] = useState(0);

  const priceNum = (() => {
    const digits = String(v.price ?? "").replace(/[^0-9.]/g, "");
    const n = parseFloat(digits);
    return Number.isFinite(n) ? n : null;
  })();
  const isUnder5k = priceNum !== null && priceNum > 0 && priceNum < 5000;
  const shownTitle = vehicleDisplayTitle(v);

  // Hide unpopulated placeholders ("See FB listing"/"Not Found") from a thin sync entry.
  const isPlaceholder = (x: any) => !x || /^(not found|see fb listing)$/i.test(String(x).trim());
  const showMileage = !isPlaceholder(v.mileage);
  const showTrans = !isPlaceholder(v.transmission);
  const d = v.details || {};
  const isTitleStatusText = (x: any) => /\b(clean|salvage|rebuilt|lien|lemon)\s+title\b/i.test(String(x || ""));
  const exteriorColor = isTitleStatusText(d.exterior_color) ? "" : d.exterior_color;
  const interiorColor = isTitleStatusText(d.interior_color) ? "" : d.interior_color;
  const hasAbout = showMileage || showTrans || exteriorColor || interiorColor || d.fuel_economy || d.title_status;

  const prev = (e: React.MouseEvent) => { e.preventDefault(); setIdx((i) => (i - 1 + photos.length) % photos.length); };
  const next = (e: React.MouseEvent) => { e.preventDefault(); setIdx((i) => (i + 1) % photos.length); };

  const cover = photos[0];
  const smsHref = dealerPhone
    ? `sms:${dealerPhone}?&body=${encodeURIComponent(`Hi, I'm interested in the ${shownTitle}. Is it still available?`)}`
    : "#contact";

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Card className="group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border-border/80 bg-card p-0 shadow-sm transition-all hover:-translate-y-1 hover:border-primary/35 hover:shadow-xl">
          <div className="relative aspect-[16/10] overflow-hidden bg-muted">
            {v.is_sold ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/50">
                <span className="rotate-[-20deg] rounded border-4 border-red-500 px-4 py-1 text-2xl font-black tracking-widest text-red-500">SOLD</span>
              </div>
            ) : isUnder5k ? (
              <span className="absolute left-3 top-3 z-10 rounded-full bg-primary px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-primary-foreground shadow">Under $5K</span>
            ) : null}
            {cover ? (
              <img src={cover} alt={shownTitle} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No photo</div>
            )}
            {photos.length > 1 && (
              <span className="absolute bottom-3 right-3 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">{photos.length} photos</span>
            )}
          </div>
          <CardContent className="flex flex-1 flex-col gap-2 p-4">
            <h3 className="line-clamp-2 min-h-[2.4em] text-sm font-bold leading-tight text-ink sm:text-base">{shownTitle}</h3>
            <div className="mt-auto flex items-baseline gap-2 pt-1">
              <span className={`text-xl font-extrabold text-primary${v.is_sold ? " line-through opacity-60" : ""}`}>{v.price}</span>
              {priceNum !== null && <span className="text-xs font-semibold text-muted-foreground">OBO</span>}
            </div>
          </CardContent>
        </Card>
      </DialogTrigger>

      <DialogContent className="w-[95vw] max-w-5xl gap-0 overflow-hidden border-0 p-0 max-h-[92vh] md:h-[86vh]">
        <div className="flex max-h-[92vh] flex-col overflow-y-auto md:grid md:h-full md:max-h-none md:grid-cols-[1.2fr_1fr] md:overflow-hidden">
          {/* LEFT — photo gallery */}
          <div className="flex min-w-0 flex-col bg-black md:min-h-0">
            <div className="relative flex min-h-0 flex-1 items-center justify-center">
              {v.is_sold && (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-black/40">
                  <span className="rotate-[-20deg] rounded border-4 border-red-500 px-5 py-1 text-3xl font-black tracking-widest text-red-500">SOLD</span>
                </div>
              )}
              {photos.length > 0 ? (
                <>
                  <img key={idx} src={photos[idx]} alt={`${shownTitle} photo ${idx + 1}`} className="max-h-[50vh] w-full object-contain md:max-h-full" />
                  {photos.length > 1 && (
                    <>
                      <button onClick={prev} className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/90 p-2 text-gray-800 shadow hover:bg-white" aria-label="Previous photo"><ChevronLeft className="h-5 w-5" /></button>
                      <button onClick={next} className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full bg-white/90 p-2 text-gray-800 shadow hover:bg-white" aria-label="Next photo"><ChevronRight className="h-5 w-5" /></button>
                    </>
                  )}
                </>
              ) : (
                <div className="flex h-full w-full items-center justify-center py-24 text-sm text-white/60">No photo</div>
              )}
            </div>
            {photos.length > 1 && (
              <div className="flex shrink-0 gap-1 bg-black/90 p-2">
                {photos.map((ph, i) => (
                  <button
                    key={i}
                    onClick={() => setIdx(i)}
                    className={`aspect-[4/3] min-w-0 flex-1 overflow-hidden rounded border-2 ${i === idx ? "border-white" : "border-transparent opacity-60 hover:opacity-100"}`}
                    aria-label={`Photo ${i + 1}`}
                  >
                    <img src={ph} alt="" className="h-full w-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* RIGHT — details + message funnel */}
          <div className="min-w-0 bg-card p-5 sm:p-6 md:min-h-0 md:overflow-y-auto">
            <DialogTitle className="pr-8 text-xl font-bold leading-snug text-ink sm:text-2xl">{shownTitle}</DialogTitle>
            <div className="mt-1.5 flex items-baseline gap-2">
              <span className={`text-2xl font-extrabold text-primary${v.is_sold ? " line-through opacity-60" : ""}`}>{v.price}</span>
              {priceNum !== null && <span className="text-sm font-semibold text-muted-foreground">OBO</span>}
            </div>
            <p className="mt-1.5 flex items-center gap-1 text-sm text-muted-foreground"><MapPin className="h-3.5 w-3.5" /> {locationText}</p>

            {v.is_sold ? (
              <div className="mt-5 rounded-md border border-border bg-muted py-3 text-center text-sm font-medium text-muted-foreground">This vehicle has sold</div>
            ) : (
              <div className="mt-5 flex flex-col gap-2">
                <Button asChild size="lg" className="w-full">
                  <a href={smsHref} onClick={() => trackLeadClick(dealerSlug, "click_text", { location: "vehicle_modal", vehicle_id: v.id, vehicle_title: shownTitle })}><MessageSquare className="mr-2 h-4 w-4" />Text About This Car</a>
                </Button>
                {dealerPhone && (
                  <Button asChild variant="outline" size="lg" className="w-full">
                    <a href={`tel:${dealerPhone}`} onClick={() => trackLeadClick(dealerSlug, "click_call", { location: "vehicle_modal", vehicle_id: v.id, vehicle_title: shownTitle })}><Phone className="mr-2 h-4 w-4" />Call {dealerPhoneDisplay}</a>
                  </Button>
                )}
              </div>
            )}

            {hasAbout && (
            <div className="mt-6 border-t border-border pt-5">
              <h4 className="mb-3 text-base font-bold text-foreground">About this vehicle</h4>
              <div className="grid grid-cols-1 gap-x-5 gap-y-3 text-sm text-muted-foreground sm:grid-cols-2">
                {showMileage && (
                  <div className="flex items-center gap-2.5"><Gauge className="h-4 w-4 shrink-0 text-foreground/70" /><span>{/^\d/.test(String(v.mileage)) ? `Driven ${v.mileage}` : v.mileage}</span></div>
                )}
                {showTrans && (
                  <div className="flex items-center gap-2.5"><Settings className="h-4 w-4 shrink-0 text-foreground/70" /><span>{/transmission/i.test(String(v.transmission)) ? v.transmission : `${v.transmission} transmission`}</span></div>
                )}
                {(exteriorColor || interiorColor) && (
                  <div className="flex items-center gap-2.5"><Palette className="h-4 w-4 shrink-0 text-foreground/70" /><span>{exteriorColor ? `Exterior: ${exteriorColor}` : ""}{exteriorColor && interiorColor ? " · " : ""}{interiorColor ? `Interior: ${interiorColor}` : ""}</span></div>
                )}
                {v.details?.fuel_economy && (
                  <div className="flex items-center gap-2.5"><Fuel className="h-4 w-4 shrink-0 text-foreground/70" /><span>{v.details.fuel_economy}</span></div>
                )}
                {v.details?.title_status && (
                  <div className="flex items-start gap-2.5">
                    <FileCheck className="mt-0.5 h-4 w-4 shrink-0 text-foreground/70" />
                    <span>
                      <span className="capitalize">{v.details.title_status}</span>
                      {/clean/i.test(String(v.details.title_status)) && (
                        <span className="block text-xs">This vehicle has no significant damage or problems.</span>
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>
            )}

            {v.description && (
              <div className="mt-6 border-t border-border pt-5">
                <h4 className="mb-2 text-base font-bold text-foreground">Description</h4>
                <p className="whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{v.description}</p>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

