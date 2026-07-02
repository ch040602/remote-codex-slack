export function splitForSlack(text: string, maxChars: number): string[] {
  const chunks: string[] = [];
  let remaining = text || "(empty)";
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  chunks.push(remaining);
  return chunks;
}

export function codeBlock(text: string, lang = ""): string {
  const fence = "```";
  return `${fence}${lang}\n${text.replaceAll("```", "`\u200b``")}\n${fence}`;
}
