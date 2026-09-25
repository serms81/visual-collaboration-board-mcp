function escape(value) { return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char])); }

export function renderSvg(board) {
  const elements = [`<rect width="${board.width}" height="${board.height}" fill="white"/>`];
  for (const overlay of board.overlays ?? []) {
    if (!overlay.bytes?.length) continue;
    const draw = overlay.fit?.draw ?? { x: 0, y: 0, width: board.width, height: board.height };
    elements.push(`<image x="${draw.x}" y="${draw.y}" width="${draw.width}" height="${draw.height}" opacity="${overlay.opacity}" href="data:image/png;base64,${overlay.bytes.toString("base64")}"/>`);
  }
  for (const element of board.elements ?? []) {
    const color = escape(element.color ?? "#cf3b46"); const width = Number(element.strokeWidth ?? 2);
    if (element.type === "text") elements.push(`<text data-element-id="${escape(element.id)}" data-author="${escape(element.author)}" x="${element.x}" y="${element.y}" fill="${color}" font-size="${Number(element.fontSize ?? 18)}px">${escape(element.text ?? "")}</text>`);
    else if (element.type === "rectangle") elements.push(`<rect data-element-id="${escape(element.id)}" data-author="${escape(element.author)}" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" fill="none" stroke="${color}" stroke-width="${width}"/>`);
    else if (element.type === "ellipse") elements.push(`<ellipse data-element-id="${escape(element.id)}" data-author="${escape(element.author)}" cx="${element.x + element.width / 2}" cy="${element.y + element.height / 2}" rx="${element.width / 2}" ry="${element.height / 2}" fill="none" stroke="${color}" stroke-width="${width}"/>`);
    else if (element.points?.length) { const points = element.points.map(([x, y]) => `${x},${y}`).join(" "); elements.push(`<polyline data-element-id="${escape(element.id)}" data-author="${escape(element.author)}" points="${points}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`); }
  }
  for (const path of board.paths ?? []) {
    const points = path.points.map(([x, y]) => `${x},${y}`).join(" ");
    elements.push(`<polyline data-path-id="${escape(path.id)}" data-author="${escape(path.author)}" points="${points}" fill="none" stroke="${escape(path.color)}" stroke-width="${path.width}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${board.width}" height="${board.height}" viewBox="0 0 ${board.width} ${board.height}">${elements.join("")}</svg>`;
}
