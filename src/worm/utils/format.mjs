
export function printTable(headers, rows) {
  if (!rows || rows.length === 0) return;
  const colWidths = headers.map((h, i) => {
    const maxRowLen = Math.max(...rows.map(r => {
      // Strip ANSI codes for length calculation
      const val = r[i];
      const str = (val !== null && val !== undefined) ? val.toString() : "";
      const clean = str.replace(/\x1b\[[0-9;]*m/g, "");
      return clean.length;
    }));
    return Math.max(h.length, maxRowLen) + 2; // +2 Padding
  });

  const border = colWidths.map(w => "─".repeat(w)).join("┼");
  console.log("┌" + border.replace(/┼/g, "┬") + "┐");

  // Header
  const headerRow = headers.map((h, i) => (h || "").toString().padEnd(colWidths[i])).join("│");
  console.log("│" + headerRow + "│");
  console.log("├" + border + "┤");

  // Rows
  rows.forEach(row => {
    const line = row.map((cell, i) => {
      const cellStr = (cell !== null && cell !== undefined) ? cell.toString() : "";
      const cleanLen = cellStr.replace(/\x1b\[[0-9;]*m/g, "").length;
      const padding = colWidths[i] - cleanLen;
      return cellStr + " ".repeat(padding);
    }).join("│");
    console.log("│" + line + "│");
  });
  console.log("└" + border.replace(/┼/g, "┴") + "┘");
}


// ============== Helper Functions ==============
// (getGenomicParam, roundQty, checkMinQuantity, parseOptionalNumber imported from utils/)

export function checkMinTrade(usdValue) {
  const MIN_TRADE_USD = 0.25;
  if (usdValue < MIN_TRADE_USD) {
    return false;
  }
  return true;
}
