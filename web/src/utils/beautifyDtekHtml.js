export function beautifyDtekHtml(html) {
    if (!html) return html;

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // 1) Зробити всі таблиці bootstrap-таблицями
    doc.querySelectorAll("table").forEach((t) => {
        t.classList.add("table", "table-bordered", "table-sm", "align-middle", "mb-0");
    });

    // 2) Обгорнути таблиці в table-responsive
    doc.querySelectorAll("table").forEach((t) => {
        const wrap = doc.createElement("div");
        wrap.className = "table-responsive";
        t.parentNode.insertBefore(wrap, t);
        wrap.appendChild(t);
    });

    // 3) Трохи підчистити заголовки/декор (опційно)
    doc.querySelectorAll(".discon-fact-info-icon, .discon-info-icon").forEach((el) => el.remove());

    // 4) Зробити клітинки компактнішими (встановимо inline мінімум)
    doc.querySelectorAll("td, th").forEach((cell) => {
        cell.style.padding = "0";
        cell.style.textAlign = "center";
        cell.style.verticalAlign = "middle";
        cell.style.minWidth = "34px";
    });

    // 5) Для тижня: “липка” перша колонка з днем
    // (у тижневій таблиці день лежить в першому td з colspan=2)
    doc.querySelectorAll(".discon-schedule-table td[colspan='2'], .discon-schedule-table th[colspan='2']")
        .forEach((cell) => {
            cell.classList.add("sticky-left");
            cell.style.background = "white";
            cell.style.zIndex = "2";
        });

    return doc.body.innerHTML;
}
