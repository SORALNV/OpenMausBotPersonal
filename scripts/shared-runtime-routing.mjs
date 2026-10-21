export function desktopRuntimeRoute({ desktopChild, appPipe, args, socketActive }) {
  if (!desktopChild || !appPipe || !args.includes('app-server') || args.includes('daemon') || args.some(a => ['--help', '-h', '--version', '-V', 'generate-json-schema', 'generate-ts', '--listen', '--stdio'].includes(a) || a.startsWith('--listen='))) return 'stdio';
  return socketActive ? 'attach' : 'create';
}
