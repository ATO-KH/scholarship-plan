(() => {
  window.atoCheckpointCalendar = (date, remaining) => {
    const [year, month, due] = String(date).split("-").map(Number);
    const first = new Date(Date.UTC(year, month - 1, 1));
    if (!Number.isFinite(first.getTime())) return "<p>Checkpoint date unavailable.</p>";
    const title = first.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const offset = first.getUTCDay();
    let cells = "";
    for (let index = 0; index < Math.ceil((offset + last) / 7) * 7; index++) {
      if (index % 7 === 0) cells += "<tr>";
      const day = index - offset + 1;
      cells += day < 1 || day > last ? '<td aria-hidden="true"></td>' : `<td${day === due ? ' class="checkpoint-due"' : ""}>${day === due ? `<span aria-label="Checkpoint due ${title} ${day}">${day}</span>` : day}</td>`;
      if (index % 7 === 6) cells += "</tr>";
    }
    return `<p class="eyebrow">NEXT CHECKPOINT</p><table class="checkpoint-calendar"><caption>${title}</caption><thead><tr>${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"].map(day => `<th scope="col"><abbr title="${day}">${day[0]}</abbr></th>`).join("")}</tr></thead><tbody>${cells}</tbody></table><div class="checkpoint-remaining">${Math.max(0, Number(remaining) || 0)} points to go!</div>`;
  };
})();
