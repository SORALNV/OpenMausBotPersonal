/** Upstream diagnostics include turn excerpts and third-party errors. Strict mode never logs their arguments. */
export function installPrivacyConsole(): () => void {
  const methods = ["log", "info", "warn", "error", "debug", "dir", "table", "trace"] as const;
  const saved = methods.map(method => [method, console[method]] as const);
  const emit = console.log.bind(console);
  for (const method of methods) console[method] = () => emit(`[privacy] ${method}: details omitted`);
  return () => { for (const [method, sink] of saved) console[method] = sink; };
}
