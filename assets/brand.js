// Daily-uptime panel for the history pages, laid out like the source.coop
// analytics UsagePanel: a stat row, a caption, and one bar per day where
// hovering a bar reports that day. Upptime renders pages in the browser, so
// this watches the DOM and fills in each history page once its summary
// appears. Data comes from history/summary.json, the file Upptime itself reads.
(() => {
  const RAW = "https://raw.githubusercontent.com/source-cooperative/status.source.coop/master";
  const DAYS = 90;
  const DAY_MS = 864e5;

  // raw.githubusercontent.com serves with max-age=300; refetch after that.
  const CACHE_MS = 5 * 60e3;

  const ok = (r) => {
    if (!r.ok) throw new Error(`${r.status} ${r.url}`);
    return r;
  };

  // Shared across history pages in one tab. A failed fetch is dropped so the
  // next page retries instead of inheriting the rejection.
  let summaries, fetchedAt = 0;
  const getSummaries = () => {
    if (!summaries || Date.now() - fetchedAt > CACHE_MS) {
      const p = fetch(`${RAW}/history/summary.json`).then(ok).then((r) => r.json());
      p.catch(() => summaries === p && (summaries = undefined));
      summaries = p;
      fetchedAt = Date.now();
    }
    return summaries;
  };

  // When monitoring of this site began; days before it have no data. Rejects
  // if the file can't be read, so the panel never presents unmonitored days
  // as fully up; Upptime's own summary stays in place instead.
  const starts = new Map();
  const getStart = (slug) => {
    if (!starts.has(slug)) {
      const p = fetch(`${RAW}/history/${slug}.yml`)
        .then(ok)
        .then((r) => r.text())
        .then((t) => {
          const m = t.match(/^startTime:\s*(\S+)/m);
          return m ? new Date(m[1]) : null;
        });
      p.catch(() => starts.delete(slug));
      starts.set(slug, p);
    }
    return starts.get(slug);
  };

  const formatDate = (d) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

  // One entry per UTC day, oldest first, ending today. Uptime is measured
  // against the minutes actually monitored, so today and the first day are
  // not diluted by hours that haven't happened or weren't checked.
  function buildDays(site, start, count = DAYS, now = new Date()) {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Array.from({ length: count }, (_, i) => {
      const date = new Date(today - (count - 1 - i) * DAY_MS);
      const key = date.toISOString().slice(0, 10);
      const down = (site.dailyMinutesDown || {})[key] || 0;
      const known = !start || date.getTime() + DAY_MS > start.getTime();
      const from = Math.max(date.getTime(), start ? start.getTime() : 0);
      const to = Math.min(date.getTime() + DAY_MS, now.getTime());
      const minutes = Math.max(1, (to - from) / 6e4);
      return { date, down, known, uptime: Math.max(0, 1 - down / minutes) };
    });
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function stat(label, value) {
    const box = el("div", "sc-stat");
    box.append(el("div", "sc-label", label), el("div", "sc-value", value));
    return box;
  }

  // Caption, one bar per day and the date range, as in the analytics card.
  // Hovering a bar turns it Grass and puts that day in the caption.
  function uptimeChart(days) {
    const caption = el("div", "sc-caption");
    const swatch = el("span", "sc-swatch");
    const captionText = el("span", "sc-label", `${days.length}-day uptime`);
    caption.append(swatch, captionText);

    const bars = el("div", "sc-bars");
    bars.setAttribute("role", "img");
    bars.setAttribute("aria-label", `Daily uptime over the past ${days.length} days`);
    days.forEach((day, i) => {
      const bar = el("div", "sc-bar");
      bar.dataset.index = i;
      if (!day.known) bar.classList.add("nodata");
      else {
        bar.style.height = `${Math.max(8, day.uptime * 100)}%`;
        if (day.down >= 60) bar.classList.add("down");
        else if (day.down > 0) bar.classList.add("partial");
      }
      bars.append(bar);
    });

    let hovered = null;
    const show = (i) => {
      if (hovered !== null) bars.children[hovered].classList.remove("hover");
      hovered = i;
      if (i === null) {
        swatch.hidden = true;
        captionText.textContent = `${days.length}-day uptime`;
        return;
      }
      const day = days[i];
      bars.children[i].classList.add("hover");
      swatch.hidden = false;
      captionText.textContent = !day.known
        ? `${formatDate(day.date)} · not monitored`
        : `${formatDate(day.date)} · ${(day.uptime * 100).toFixed(2)}% up` +
          (day.down ? ` · ${day.down} min down` : "");
    };
    show(null);
    bars.addEventListener("mouseover", (e) => {
      const i = e.target.dataset && e.target.dataset.index;
      if (i !== undefined) show(Number(i));
    });
    bars.addEventListener("mouseleave", () => show(null));

    const range = el("div", "sc-range");
    range.append(
      el("span", "sc-label", formatDate(days[0].date)),
      el("span", "sc-label", formatDate(days[days.length - 1].date)),
    );

    return [caption, bars, range];
  }

  function render(site, start) {
    const days = buildDays(site, start);
    const panel = el("div", "sc-panel");

    const stats = el("div", "sc-stats");
    stats.append(
      stat("Uptime 24h", site.uptimeDay),
      stat("Uptime 7d", site.uptimeWeek),
      stat("Uptime 30d", site.uptimeMonth),
      stat("Response 7d", `${site.timeWeek} ms`),
    );
    const statsRow = el("div", "sc-stat-row");
    statsRow.append(stats);

    panel.append(statsRow, ...uptimeChart(days));
    return panel;
  }

  // Upptime's history summary is a <section> holding the site's <h1> and a
  // <dl> of overall uptime and response time; the panel replaces the <dl>.
  async function enhance() {
    const match = location.pathname.match(/\/history\/([^/]+)\/?$/);
    if (!match) return;
    const dl = document.querySelector("section > h1 + dl:not([data-sc])");
    if (!dl) return;
    dl.dataset.sc = "1";
    const slug = decodeURIComponent(match[1]);
    const [all, start] = await Promise.all([getSummaries(), getStart(slug)]);
    const site = all.find((s) => s.slug === slug);
    if (!site || !dl.isConnected) return;
    dl.hidden = true;
    dl.after(render(site, start));
  }

  // Index cards: Upptime draws each site's response time as a teal PNG
  // background (brand.css hides it); put a compact 30-day strip there instead.
  function enhanceIndex() {
    for (const card of document.querySelectorAll("section.live-status article:not([data-sc])")) {
      const link = card.querySelector("h4 a[href*='/history/']");
      if (!link) continue;
      card.dataset.sc = "1";
      const slug = decodeURIComponent(link.getAttribute("href").split("/history/")[1].replace(/\/$/, ""));
      Promise.all([getSummaries(), getStart(slug)])
        .then(([all, start]) => {
          const site = all.find((s) => s.slug === slug);
          if (!site || !card.isConnected) return;
          const mini = el("div", "sc-mini");
          mini.append(...uptimeChart(buildDays(site, start, 30)));
          card.append(mini);
        })
        .catch(() => {});
    }
  }

  new MutationObserver(() => {
    enhanceIndex();
    enhance().catch(() => {});
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
