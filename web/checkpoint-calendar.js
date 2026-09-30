(() => {
  const dayMs = 86400000;
  const format = (date, options) => date.toLocaleDateString("en-US", { ...options, timeZone: "UTC" });
  const calendarDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  window.atoCheckpointCalendar = (deadline, remaining, today = calendarDay()) => {
    const center = new Date(`${today}T00:00:00Z`);
    if (!Number.isFinite(center.getTime())) return "<p>Calendar unavailable.</p>";
    const start = new Date(center.getTime() - 14 * dayMs);
    const end = new Date(center.getTime() + 14 * dayMs);
    const title = `${format(start, { month: "short", day: "numeric", ...(start.getUTCFullYear() !== end.getUTCFullYear() ? { year: "numeric" } : {}) })} – ${format(end, { month: "short", day: "numeric", year: "numeric" })}`;
    const offset = start.getUTCDay();
    let cells = "";
    for (let index = 0; index < Math.ceil((offset + 29) / 7) * 7; index++) {
      if (index % 7 === 0) cells += "<tr>";
      const relative = index - offset;
      if (relative < 0 || relative > 28) cells += '<td aria-hidden="true"></td>';
      else {
        const date = new Date(start.getTime() + relative * dayMs);
        const key = date.toISOString().slice(0, 10);
        const current = key === today, due = key === deadline;
        const label = `${format(date, { month: "long", day: "numeric", year: "numeric" })}${current ? ", today" : ""}${due ? ", checkpoint due" : ""}`;
        cells += `<td class="${current ? "calendar-today " : ""}${due ? "checkpoint-due" : ""}" data-date="${key}"${current ? ' aria-current="date"' : ""}><span aria-label="${label}">${date.getUTCDate()}</span>${current ? '<small>Today</small>' : date.getUTCDate() === 1 ? `<small>${format(date, { month: "short" })}</small>` : ""}${due ? '<span class="calendar-due-dot" aria-hidden="true"></span>' : ""}</td>`;
      }
      if (index % 7 === 6) cells += "</tr>";
    }
    return `<p class="eyebrow">NEXT CHECKPOINT</p><table class="checkpoint-calendar"><caption>${title}</caption><thead><tr>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map(day => `<th scope="col"><abbr title="${day}">${day[0]}</abbr></th>`).join("")}</tr></thead><tbody>${cells}</tbody></table><div class="checkpoint-remaining">${Math.max(0, Number(remaining) || 0)} points to go!</div>`;
  };
})();
