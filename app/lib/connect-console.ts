/** Device management has one home; local development runs the console beside Games. */
export function connectConsoleUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_CONNECT_CONSOLE_URL ?? "http://localhost:3001";
  const url = new URL(base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Connect console must use an HTTP address without credentials");
  }
  return new URL(path, url.origin).href;
}
